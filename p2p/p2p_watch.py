"""P2P attestation watcher: subscribes to the beacon node's SSE event stream
and records when log-discovered validators' attestations were actually seen on
gossip.

Populates attmon.p2p_attestations:
  propagation_delay_ms  ms from slot start until the attestation was seen
  subnet_id             attestation subnet (deterministic from slot+committee)
  aggregator_picked     0 = seen unaggregated, 1 = seen inside an aggregate

Two event topics:
  single_attestation  (post-Electra) carries attester_index directly — fires
                      when the node sees an unaggregated attestation on a
                      subscribed subnet
  attestation         carries aggregates (committee_bits + aggregation_bits);
                      we test our validator's bit to detect pickup by an
                      aggregator

Arrival time is our own wall clock at event receipt — same measurement a
dedicated sentry would make, minus the extra container.
"""

import json
import logging
import os
import re
import sys
import time

import requests

BEACON_URL = os.environ.get("BEACON_URL", "http://hoodi-lighthouse:5052")
CLICKHOUSE_URL = os.environ.get("CLICKHOUSE_URL", "http://clickhouse:8123")
CH_USER = os.environ.get("CLICKHOUSE_USER", "attmon")
CH_PASSWORD = os.environ.get("CLICKHOUSE_PASSWORD", "attmon")
VC_LOG_PATH = os.environ.get("VC_LOG_PATH", "/var/log/lighthouse-vc/validator.log")
MONITORED_VALIDATORS = {}

SLOTS_PER_EPOCH = 32
SECONDS_PER_SLOT = 12
ATTESTATION_SUBNET_COUNT = 64

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", stream=sys.stdout
)
log = logging.getLogger("p2pwatch")

session = requests.Session()


def beacon_get(path, **kw):
    r = session.get(f"{BEACON_URL}{path}", timeout=30, **kw)
    r.raise_for_status()
    return r.json()


def ch_insert(row):
    r = requests.post(
        CLICKHOUSE_URL,
        params={"query": "INSERT INTO attmon.p2p_attestations FORMAT JSONEachRow"},
        data=json.dumps(row),
        auth=(CH_USER, CH_PASSWORD),
        timeout=30,
    )
    if not r.ok:
        log.error("clickhouse insert failed: %s %s", r.status_code, r.text[:300])


def ch_query(query, data=None):
    r = requests.post(
        CLICKHOUSE_URL,
        params={"query": query},
        data=data,
        auth=(CH_USER, CH_PASSWORD),
        timeout=30,
    )
    if not r.ok:
        raise RuntimeError(f"ClickHouse error: {r.status_code} {r.text[:500]}")
    return r.text


def ch_json(query):
    return json.loads(ch_query(query))


def ensure_schema():
    ch_query(
        "ALTER TABLE attmon.node_events "
        "ADD COLUMN IF NOT EXISTS validator_pubkey String DEFAULT ''"
    )
    ch_query(
        "ALTER TABLE attmon.node_events "
        "ADD COLUMN IF NOT EXISTS validator_name String DEFAULT ''"
    )
    ch_query(
        "ALTER TABLE attmon.p2p_attestations "
        "ADD COLUMN IF NOT EXISTS validator_pubkey String DEFAULT ''"
    )
    ch_query(
        "ALTER TABLE attmon.p2p_attestations "
        "ADD COLUMN IF NOT EXISTS validator_name String DEFAULT ''"
    )
    ch_query(
        """
        CREATE TABLE IF NOT EXISTS attmon.local_validators
        (
            validator_index UInt64,
            validator_pubkey String,
            validator_name String,
            source LowCardinality(String),
            last_seen DateTime DEFAULT now()
        )
        ENGINE = ReplacingMergeTree(last_seen)
        ORDER BY validator_index
        """
    )


def discover_validator_log_identities():
    identities = discover_validator_log_file_identities()
    rows = ch_json(
        """
        SELECT
            validator_pubkey,
            anyLast(if(validator_name = '', validator_pubkey, validator_name)) AS validator_name
        FROM attmon.node_events
        WHERE src = 'validator' AND validator_pubkey != ''
        GROUP BY validator_pubkey
        FORMAT JSON
        """
    )["data"]
    identities.update(
        {
            row["validator_pubkey"]: row.get("validator_name") or row["validator_pubkey"]
            for row in rows
        }
    )
    return identities


def discover_validator_log_file_identities():
    if not os.path.exists(VC_LOG_PATH):
        return {}

    pubkeys = {}
    pattern = re.compile(r'(?:voting_pubkey: "?|pubkey: )(0x[0-9a-fA-F]+)"?')
    with open(VC_LOG_PATH, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            if (
                "Enabled validator" not in line
                and "Validator without index" not in line
                and "Failed to resolve pubkey to index" not in line
            ):
                continue
            match = pattern.search(line)
            if match:
                pubkey = match.group(1).lower()
                pubkeys[pubkey] = pubkey
    return pubkeys


def resolve_validator_indices(pubkeys):
    if not pubkeys:
        return {}
    ids = ",".join(sorted(pubkeys))
    data = beacon_get(f"/eth/v1/beacon/states/head/validators?id={ids}")["data"]
    return {
        item["validator"]["pubkey"]: int(item["index"])
        for item in data
    }


def upsert_local_validators(validators):
    if not validators:
        return
    rows = []
    for validator_index, info in validators.items():
        rows.append(
            {
                "validator_index": validator_index,
                "validator_pubkey": info["pubkey"],
                "validator_name": info["name"],
                "source": "lighthouse_logs",
            }
        )
    ch_query(
        "INSERT INTO attmon.local_validators FORMAT JSONEachRow",
        data="\n".join(json.dumps(row) for row in rows),
    )


def load_cached_validators():
    rows = ch_json(
        """
        SELECT
            validator_index,
            argMax(validator_pubkey, last_seen) AS validator_pubkey,
            argMax(validator_name, last_seen) AS validator_name
        FROM attmon.local_validators
        GROUP BY validator_index
        FORMAT JSON
        """
    )["data"]
    return {
        int(row["validator_index"]): {
            "pubkey": row["validator_pubkey"],
            "name": row["validator_name"],
        }
        for row in rows
    }


def get_monitored_validators():
    log_identities = discover_validator_log_identities()
    validators = {}
    if log_identities:
        resolved = resolve_validator_indices(log_identities.keys())
        validators = {
            index: {"pubkey": pubkey, "name": log_identities[pubkey]}
            for pubkey, index in resolved.items()
        }
        upsert_local_validators(validators)

    # Live discovery can go quiet (debug logs off, VC log rotated past its
    # one-time "Enabled validator" line, Vector lagging) without those
    # validators having stopped existing on-chain. Once a validator has been
    # discovered at least once it stays monitored from this cache, so
    # propagation/aggregation watching never stalls just because the logs
    # became unreadable.
    for index, info in load_cached_validators().items():
        validators.setdefault(index, info)

    return validators


def bit_set(hex_bits, i):
    raw = bytes.fromhex(hex_bits[2:] if hex_bits.startswith("0x") else hex_bits)
    byte = i // 8
    return byte < len(raw) and (raw[byte] >> (i % 8)) & 1 == 1


def subnet_for(slot, committee_index, committees_per_slot):
    return (
        committees_per_slot * (slot % SLOTS_PER_EPOCH) + committee_index
    ) % ATTESTATION_SUBNET_COUNT


class Duties:
    """Our validators' attestation duties, refreshed per epoch.

    duty[slot] = list of (validator_index, committee_index, position)
    sizes[slot] = {committee_index: size}
    """

    def __init__(self):
        self.duty = {}
        self.sizes = {}
        self.loaded_epochs = set()

    def refresh(self, epoch):
        if epoch in self.loaded_epochs:
            return
        data = beacon_get(f"/eth/v1/beacon/states/head/committees?epoch={epoch}")
        for c in data["data"]:
            slot = int(c["slot"])
            ci = int(c["index"])
            validators = [int(v) for v in c["validators"]]
            self.sizes.setdefault(slot, {})[ci] = len(validators)
            for vidx in MONITORED_VALIDATORS:
                if vidx in validators:
                    self.duty.setdefault(slot, []).append(
                        (vidx, ci, validators.index(vidx))
                    )
        self.loaded_epochs.add(epoch)
        # drop anything older than 2 epochs to keep memory flat
        floor = (epoch - 2) * SLOTS_PER_EPOCH
        for s in [s for s in self.sizes if s < floor]:
            self.sizes.pop(s, None)
            self.duty.pop(s, None)
        self.loaded_epochs = {e for e in self.loaded_epochs if e >= epoch - 2}
        log.info(
            "duties epoch %s: %s",
            epoch,
            {s: d for s, d in self.duty.items() if s // SLOTS_PER_EPOCH == epoch},
        )


def our_bit_in_aggregate(att, vidx, ci, pos, sizes):
    committee_bits = att.get("committee_bits")
    if committee_bits is None:  # pre-Electra aggregate
        if int(att["data"]["index"]) != ci:
            return False
        return bit_set(att["aggregation_bits"], pos)
    if not bit_set(committee_bits, ci):
        return False
    offset = sum(sizes.get(c, 0) for c in range(ci) if bit_set(committee_bits, c))
    return bit_set(att["aggregation_bits"], offset + pos)


def sse_events(topics):
    """Yield (event_name, parsed_json) from the beacon SSE stream."""
    r = session.get(
        f"{BEACON_URL}/eth/v1/events",
        params={"topics": topics},
        stream=True,
        timeout=(10, 120),
        headers={"Accept": "text/event-stream"},
    )
    r.raise_for_status()
    event = None
    for raw in r.iter_lines(decode_unicode=True):
        if raw is None:
            continue
        if raw.startswith("event:"):
            event = raw.split(":", 1)[1].strip()
        elif raw.startswith("data:") and event:
            try:
                yield event, json.loads(raw.split(":", 1)[1].strip())
            except json.JSONDecodeError:
                pass


def head_epoch(genesis):
    """Epoch of the beacon node's current head.

    Derived from the node's head slot, NOT wall clock: while the node
    range-syncs, its head lags real time by many epochs, and
    `states/head/committees?epoch=N` 400s for any epoch far from the head
    state. Using the head epoch keeps duty refreshes valid (and aligned with
    the slots the SSE stream is actually delivering). Falls back to wall clock
    only if the head can't be read.
    """
    try:
        hdr = beacon_get("/eth/v1/beacon/headers/head")
        return int(hdr["data"]["header"]["message"]["slot"]) // SLOTS_PER_EPOCH
    except Exception as e:
        log.warning("could not read head; falling back to wall-clock epoch (%s)", e)
        return int(time.time() - genesis) // SECONDS_PER_SLOT // SLOTS_PER_EPOCH


def refresh_epoch_window(duties, epoch):
    # Both refreshes are non-fatal: a syncing node 400s on committee lookups,
    # and that must NOT kill the SSE loop (the old crash-loop that left
    # p2p_attestations empty). Worst case we just lack duties for a window.
    try:
        duties.refresh(epoch)
    except Exception as e:
        log.warning("duties for epoch %s unavailable (%s); continuing", epoch, e)
    try:
        duties.refresh(epoch + 1)
    except Exception as e:
        log.warning("next epoch duties unavailable (%s); continuing with epoch %s", e, epoch)


def main():
    global MONITORED_VALIDATORS
    ensure_schema()
    log.info("watching %s for validators discovered from logs", BEACON_URL)
    genesis = int(beacon_get("/eth/v1/beacon/genesis")["data"]["genesis_time"])
    duties = Duties()
    seen_unagg = {}  # (slot, vidx) -> propagation_delay_ms of first unagg sighting
    last_roll_check = 0.0  # wall-clock throttle for the per-event head lookup

    while True:
        try:
            MONITORED_VALIDATORS = get_monitored_validators()
            if not MONITORED_VALIDATORS:
                log.warning("no validator pubkeys found in logs yet; waiting")
                time.sleep(5)
                continue
            log.info("monitoring validators from logs: %s", sorted(MONITORED_VALIDATORS))
            now_epoch = head_epoch(genesis)
            refresh_epoch_window(duties, now_epoch)

            for event, data in sse_events("attestation,single_attestation"):
                now_ms = time.time() * 1000

                if event == "single_attestation":
                    vidx = int(data.get("attester_index", -1))
                    if vidx not in MONITORED_VALIDATORS:
                        continue
                    slot = int(data["data"]["slot"])
                    ci = int(data.get("committee_index", data["data"].get("index", 0)))
                    delay = now_ms - (genesis + slot * SECONDS_PER_SLOT) * 1000
                    cps = len(duties.sizes.get(slot, {})) or 1
                    seen_unagg[(slot, vidx)] = delay
                    row = {
                        "slot": slot,
                        "validator_index": vidx,
                        "validator_pubkey": MONITORED_VALIDATORS[vidx]["pubkey"],
                        "validator_name": MONITORED_VALIDATORS[vidx]["name"],
                        "propagation_delay_ms": round(delay, 1),
                        "subnet_id": subnet_for(slot, ci, cps),
                        "aggregator_picked": 0,
                    }
                    ch_insert(row)
                    log.info("unagg seen: %s", row)

                elif event == "attestation":
                    slot = int(data["data"]["slot"])
                    for vidx, ci, pos in duties.duty.get(slot, []):
                        if not our_bit_in_aggregate(
                            data, vidx, ci, pos, duties.sizes.get(slot, {})
                        ):
                            continue
                        agg_delay = now_ms - (genesis + slot * SECONDS_PER_SLOT) * 1000
                        # keep the first-unagg propagation number if we have it —
                        # that's when OUR attestation hit the wire; the aggregate
                        # sighting only proves an aggregator picked it up
                        delay = seen_unagg.get((slot, vidx), agg_delay)
                        cps = len(duties.sizes.get(slot, {})) or 1
                        row = {
                            "slot": slot,
                            "validator_index": vidx,
                            "validator_pubkey": MONITORED_VALIDATORS[vidx]["pubkey"],
                            "validator_name": MONITORED_VALIDATORS[vidx]["name"],
                            "propagation_delay_ms": round(delay, 1),
                            "subnet_id": subnet_for(slot, ci, cps),
                            "aggregator_picked": 1,
                        }
                        ch_insert(row)
                        log.info("aggregate pickup: %s", row)

                # roll duty window forward as the node's head advances. Throttle
                # the head lookup to once per ~24s so it doesn't fire an HTTP
                # call on every streamed attestation.
                if time.time() - last_roll_check > 24:
                    last_roll_check = time.time()
                    e = head_epoch(genesis)
                    if e + 1 not in duties.loaded_epochs:
                        refresh_epoch_window(duties, e)
                if len(seen_unagg) > 512:
                    seen_unagg.clear()

        except Exception as e:
            log.warning("stream dropped (%s); reconnecting in 5s", e)
            time.sleep(5)


if __name__ == "__main__":
    main()
