"""P2P attestation watcher: subscribes to the beacon node's SSE event stream
and records when our validators' attestations were actually seen on gossip.

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
import sys
import time

import requests

BEACON_URL = os.environ.get("BEACON_URL", "http://hoodi-lighthouse:5052")
CLICKHOUSE_URL = os.environ.get("CLICKHOUSE_URL", "http://clickhouse:8123")
CH_USER = os.environ.get("CLICKHOUSE_USER", "attmon")
CH_PASSWORD = os.environ.get("CLICKHOUSE_PASSWORD", "attmon")
VALIDATOR_INDICES = {
    int(v) for v in os.environ.get("VALIDATOR_INDICES", "1454096").split(",")
}

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
            for vidx in VALIDATOR_INDICES:
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


def main():
    log.info("watching %s for validators %s", BEACON_URL, sorted(VALIDATOR_INDICES))
    genesis = int(beacon_get("/eth/v1/beacon/genesis")["data"]["genesis_time"])
    duties = Duties()
    seen_unagg = {}  # (slot, vidx) -> propagation_delay_ms of first unagg sighting

    while True:
        try:
            now_epoch = int(time.time() - genesis) // SECONDS_PER_SLOT // SLOTS_PER_EPOCH
            duties.refresh(now_epoch)
            duties.refresh(now_epoch + 1)

            for event, data in sse_events("attestation,single_attestation"):
                now_ms = time.time() * 1000

                if event == "single_attestation":
                    vidx = int(data.get("attester_index", -1))
                    if vidx not in VALIDATOR_INDICES:
                        continue
                    slot = int(data["data"]["slot"])
                    ci = int(data.get("committee_index", data["data"].get("index", 0)))
                    delay = now_ms - (genesis + slot * SECONDS_PER_SLOT) * 1000
                    cps = len(duties.sizes.get(slot, {})) or 1
                    seen_unagg[(slot, vidx)] = delay
                    row = {
                        "slot": slot,
                        "validator_index": vidx,
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
                            "propagation_delay_ms": round(delay, 1),
                            "subnet_id": subnet_for(slot, ci, cps),
                            "aggregator_picked": 1,
                        }
                        ch_insert(row)
                        log.info("aggregate pickup: %s", row)

                # roll duty window forward as epochs tick over
                e = int(time.time() - genesis) // SECONDS_PER_SLOT // SLOTS_PER_EPOCH
                if e + 1 not in duties.loaded_epochs:
                    duties.refresh(e)
                    duties.refresh(e + 1)
                if len(seen_unagg) > 512:
                    seen_unagg.clear()

        except Exception as e:
            log.warning("stream dropped (%s); reconnecting in 5s", e)
            time.sleep(5)


if __name__ == "__main__":
    main()
