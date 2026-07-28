"""Chain Indexer: polls the beacon REST API for finalized epochs and writes
one row per validator discovered from local Lighthouse logs per duty slot to
ClickHouse.

Handles both pre-Electra attestations (data.index = committee) and
post-Electra attestations (committee_bits + concatenated aggregation_bits),
which is what Hoodi produces today.
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
BACKFILL_EPOCHS = int(os.environ.get("BACKFILL_EPOCHS", "3"))
# How many trailing epochs to re-evaluate each poll once the node is trusted,
# so vote verdicts written while it was still syncing get overwritten (self-heal).
REEVAL_EPOCHS = int(os.environ.get("REEVAL_EPOCHS", "8"))
POLL_SECONDS = int(os.environ.get("POLL_SECONDS", "60"))

SLOTS_PER_EPOCH = 32
SECONDS_PER_SLOT = 12
ATTESTATION_DEADLINE_MS = 4000

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", stream=sys.stdout
)
log = logging.getLogger("indexer")

session = requests.Session()


def beacon_get(path, ok_404=False):
    r = session.get(f"{BEACON_URL}{path}", timeout=60)
    if r.status_code == 404 and ok_404:
        return None
    r.raise_for_status()
    return r.json()


def ch_query(query, data=None):
    r = requests.post(
        CLICKHOUSE_URL,
        params={"query": query},
        data=data,
        auth=(CH_USER, CH_PASSWORD),
        timeout=60,
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
        "ALTER TABLE attmon.chain_attestations "
        "ADD COLUMN IF NOT EXISTS validator_pubkey String DEFAULT ''"
    )
    ch_query(
        "ALTER TABLE attmon.chain_attestations "
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


def get_monitored_validators():
    log_identities = discover_validator_log_identities()
    if not log_identities:
        return {}

    resolved = resolve_validator_indices(log_identities.keys())
    validators = {
        index: {"pubkey": pubkey, "name": log_identities[pubkey]}
        for pubkey, index in resolved.items()
    }
    upsert_local_validators(validators)
    return validators


# --- SSZ bitfield helpers -------------------------------------------------
# Both bitlists and bitvectors are hex-encoded little-endian-within-byte:
# bit i lives in byte i//8 at position i%8.

def bit_set(hex_bits, i):
    raw = bytes.fromhex(hex_bits[2:] if hex_bits.startswith("0x") else hex_bits)
    byte = i // 8
    if byte >= len(raw):
        return False
    return (raw[byte] >> (i % 8)) & 1 == 1


def find_our_bit(att, committee_index, committee_position, committee_sizes):
    """Return True if our validator's bit is set in this attestation.

    Post-Electra: aggregation_bits concatenates the committees flagged in
    committee_bits (ascending committee order), so our absolute bit position
    is the sum of sizes of flagged committees before ours + our position.
    """
    committee_bits = att.get("committee_bits")
    if committee_bits is None:  # pre-Electra: one committee per attestation
        if int(att["data"]["index"]) != committee_index:
            return False
        return bit_set(att["aggregation_bits"], committee_position)

    if not bit_set(committee_bits, committee_index):
        return False
    offset = 0
    for ci in range(committee_index):
        if bit_set(committee_bits, ci):
            offset += committee_sizes.get(ci, 0)
    return bit_set(att["aggregation_bits"], offset + committee_position)


# --- Beacon API helpers ---------------------------------------------------

def get_genesis_time():
    return int(beacon_get("/eth/v1/beacon/genesis")["data"]["genesis_time"])


def get_finalized_epoch():
    data = beacon_get("/eth/v1/beacon/states/head/finality_checkpoints")["data"]
    return int(data["finalized"]["epoch"])


def node_is_optimistic():
    """True if the beacon node's head is optimistic, still syncing, or its EL
    is offline — states in which its canonical view can't be trusted for
    vote-correctness verdicts. On any error, treat as untrusted.

    While the node range-syncs, `/eth/v1/beacon/headers/{slot}` returns an
    unstable optimistic head, so `head_correct` computed against it disagrees
    with the settled canonical chain (the false-green head-vote bug). We write
    NULL verdicts in that window and re-evaluate once the node is trusted.
    """
    try:
        d = beacon_get("/eth/v1/beacon/syncing")["data"]
        return (
            bool(d.get("is_optimistic"))
            or bool(d.get("is_syncing"))
            or bool(d.get("el_offline"))
        )
    except Exception:
        log.warning("could not read /eth/v1/beacon/syncing; treating node as untrusted")
        return True


def get_target_epoch():
    """Newest epoch that can be fully judged: attestations for epoch E are
    includible through the end of epoch E+1, so E is closed once the node's
    head reaches E+2. Head-based, not finality-based — keeps the monitor
    ~2 epochs behind the chain instead of finality-lag + node-sync-lag.
    Tiny reorg risk on non-finalized epochs is acceptable for monitoring."""
    hdr = beacon_get("/eth/v1/beacon/headers/head")
    head_slot = int(hdr["data"]["header"]["message"]["slot"])
    return head_slot // SLOTS_PER_EPOCH - 2


def get_committees(epoch):
    """Committee assignments for an epoch, keyed by slot.

    Uses the head state: Lighthouse prunes mid-epoch historical states, but
    the head state carries the randao history needed to compute shuffling
    for recent past epochs.

    Returns {slot: {committee_index: [validator_index, ...]}}.
    """
    data = beacon_get(f"/eth/v1/beacon/states/head/committees?epoch={epoch}")
    out = {}
    for c in data["data"]:
        slot = int(c["slot"])
        out.setdefault(slot, {})[int(c["index"])] = [int(v) for v in c["validators"]]
    return out


def get_block_attestations(slot):
    """Attestations from the block at `slot`, or None if the slot is empty.

    Uses the dedicated attestations endpoint rather than the full block:
    lighter, and the full-block endpoint 500s when the execution layer
    hasn't backfilled the payload body yet.
    """
    resp = beacon_get(f"/eth/v1/beacon/blocks/{slot}/attestations", ok_404=True)
    if resp is None:
        return None
    return resp["data"]


def count_set_bits(hex_bits, is_bitlist=True):
    """Number of set bits in an SSZ hex bitfield (minus the bitlist length marker)."""
    raw = bytes.fromhex(hex_bits[2:] if hex_bits.startswith("0x") else hex_bits)
    n = sum(bin(b).count("1") for b in raw)
    return max(n - 1, 0) if is_bitlist else n


ATTESTATION_SUBNET_COUNT = 64


def subnet_for(slot, committee_index, committees_per_slot):
    """Deterministic gossip subnet for an unaggregated attestation (spec:
    compute_subnet_for_attestation) — no p2p sentry needed."""
    slots_since_epoch_start = slot % SLOTS_PER_EPOCH
    return (
        committees_per_slot * slots_since_epoch_start + committee_index
    ) % ATTESTATION_SUBNET_COUNT


def get_block_facts(slot):
    """Block-level facts for the duty slot. Tolerates the EL not having the
    payload yet (full-block endpoint 500s while geth syncs) by falling back
    to the header endpoint."""
    facts = {
        "block_on_chain": 0,
        "proposer_index": None,
        "exec_block_number": None,
        "exec_block_hash": "",
        "state_root": "",
        "graffiti": "",
        "blob_count": None,
    }
    hdr = beacon_get(f"/eth/v1/beacon/headers/{slot}", ok_404=True)
    if hdr is None:
        return facts  # empty slot — no block proposed / none canonical
    msg = hdr["data"]["header"]["message"]
    facts["block_on_chain"] = 1
    facts["proposer_index"] = int(msg["proposer_index"])
    facts["state_root"] = msg["state_root"]
    try:
        blk = beacon_get(f"/eth/v2/beacon/blocks/{slot}", ok_404=True)
        body = blk["data"]["message"]["body"]
        payload = body.get("execution_payload", {})
        if payload:
            facts["exec_block_number"] = int(payload["block_number"])
            facts["exec_block_hash"] = payload.get("block_hash", "")
        g = body.get("graffiti", "")
        if g.startswith("0x"):
            facts["graffiti"] = (
                bytes.fromhex(g[2:]).rstrip(b"\x00").decode("utf-8", "replace")
            )
        facts["blob_count"] = len(body.get("blob_kzg_commitments", []))
    except Exception as e:
        log.warning("full block fetch failed at slot %s (%s); header facts only", slot, e)
    return facts


def slot_of_root(root):
    """Slot of a block root, or None if unknown."""
    if not root:
        return None
    hdr = beacon_get(f"/eth/v1/beacon/headers/{root}", ok_404=True)
    if hdr is None:
        return None
    return int(hdr["data"]["header"]["message"]["slot"])


def canonical_root_at(slot, floor_slot=0):
    """Root of the canonical block at `slot`, walking back through empty slots."""
    for s in range(slot, max(floor_slot, slot - SLOTS_PER_EPOCH) - 1, -1):
        hdr = beacon_get(f"/eth/v1/beacon/headers/{s}", ok_404=True)
        if hdr is not None:
            return hdr["data"]["root"]
    return ""


# --- Epoch processing -----------------------------------------------------

def process_epoch(epoch, genesis_time, validators, trustworthy=True):
    committees = get_committees(epoch)
    validator_indices = set(validators)

    # Locate every log-discovered validator's duty in this epoch.
    duties = {}  # validator_index -> (slot, committee_index, position)
    for slot, comms in committees.items():
        for ci, committee_validators in comms.items():
            for vidx in validator_indices:
                if vidx in committee_validators:
                    duties[vidx] = (slot, ci, committee_validators.index(vidx))
    for vidx in validator_indices:
        if vidx not in duties:
            log.warning("validator %s has no duty in epoch %s (unexpected)", vidx, epoch)

    canonical_target = canonical_root_at(epoch * SLOTS_PER_EPOCH)

    # Attestations for slot S may be included in any block up to the end of
    # epoch(S)+1 (EIP-7045). Fetch blocks lazily, cache per inclusion slot.
    block_cache = {}

    rows = []
    for vidx, (duty_slot, ci, pos) in duties.items():
        committee_sizes = {
            i: len(v) for i, v in committees[duty_slot].items()
        }
        found = None  # (inclusion_slot, attestation)
        last_inclusion_slot = (epoch + 2) * SLOTS_PER_EPOCH - 1
        for incl_slot in range(duty_slot + 1, last_inclusion_slot + 1):
            if incl_slot not in block_cache:
                block_cache[incl_slot] = get_block_attestations(incl_slot)
            atts = block_cache[incl_slot]
            if atts is None:
                continue
            for att in atts:
                if int(att["data"]["slot"]) != duty_slot:
                    continue
                if find_our_bit(att, ci, pos, committee_sizes):
                    found = (incl_slot, att)
                    break
            if found:
                break

        canonical_head = canonical_root_at(duty_slot)
        committees_per_slot = len(committees[duty_slot])
        row = {
            "epoch": epoch,
            "slot": duty_slot,
            "slot_start_utc": time.strftime(
                "%Y-%m-%d %H:%M:%S",
                time.gmtime(genesis_time + duty_slot * SECONDS_PER_SLOT),
            ),
            "validator_index": vidx,
            "validator_pubkey": validators[vidx]["pubkey"],
            "validator_name": validators[vidx]["name"],
            "committee_index": ci,
            "committee_position": pos,
            "canonical_head_root": canonical_head,
            "subnet_id": subnet_for(duty_slot, ci, committees_per_slot),
            "committee_size": committee_sizes.get(ci),
        }
        row.update(get_block_facts(duty_slot))
        if found:
            incl_slot, att = found
            data = att["data"]
            attested_head_slot = slot_of_root(data["beacon_block_root"])
            row.update(
                attested_head_root=data["beacon_block_root"],
                attested_target_root=data["target"]["root"],
                attested_source_root=data["source"]["root"],
                # NULL (not 0) when the node is untrusted or canonical is
                # unresolved: renders as "–" instead of a confident wrong verdict.
                # Re-evaluated once the node is trusted (see main()).
                head_correct=int(data["beacon_block_root"] == canonical_head)
                if (trustworthy and canonical_head)
                else None,
                target_correct=int(data["target"]["root"] == canonical_target)
                if (trustworthy and canonical_target)
                else None,
                # how many slots behind the duty slot the attested head was
                head_lag_slots=(duty_slot - attested_head_slot)
                if attested_head_slot is not None
                else None,
                # participants in the aggregate that carried our vote
                agg_bits_set=count_set_bits(att["aggregation_bits"]),
                # Consensus rules reject attestations whose source vote doesn't
                # match the state's justified checkpoint, so inclusion in a
                # block proves the source vote was correct.
                source_correct=1,
                inclusion_slot=incl_slot,
                inclusion_distance=incl_slot - duty_slot,
                included_in_aggregate=1,
                missed=0,
            )
        else:
            row.update(
                attested_head_root="",
                attested_target_root="",
                attested_source_root="",
                head_correct=0,
                target_correct=0,
                source_correct=0,
                inclusion_slot=None,
                inclusion_distance=None,
                included_in_aggregate=0,
                missed=1,
                head_lag_slots=None,
                agg_bits_set=None,
            )
        rows.append(row)
        log.info(
            "epoch %s validator %s slot %s: %s",
            epoch,
            vidx,
            duty_slot,
            "included at slot %s (distance %s)" % (row["inclusion_slot"], row["inclusion_distance"])
            if found
            else "MISSED",
        )

    if rows:
        payload = "\n".join(json.dumps(r) for r in rows)
        ch_query(
            "INSERT INTO attmon.chain_attestations FORMAT JSONEachRow", data=payload
        )
    return len(rows)


def last_processed_epoch(validators):
    if not validators:
        return None
    txt = ch_query(
        "SELECT max(epoch) FROM attmon.chain_attestations "
        f"WHERE validator_index IN ({','.join(map(str, validators))})"
    ).strip()
    return int(txt) if txt and txt != "0" else None


def main():
    ensure_schema()
    log.info("starting: beacon=%s backfill=%s epochs", BEACON_URL, BACKFILL_EPOCHS)
    genesis_time = get_genesis_time()

    while True:
        try:
            validators = get_monitored_validators()
            if not validators:
                log.warning("no validator pubkeys found in logs yet; waiting")
                time.sleep(POLL_SECONDS)
                continue
            log.info("monitoring validators from logs: %s", sorted(validators))
            target = get_target_epoch()
            trustworthy = not node_is_optimistic()
            done = last_processed_epoch(validators)
            start_new = (done + 1) if done else max(target - BACKFILL_EPOCHS + 1, 0)
            # When the node is trusted, walk back over a trailing window and
            # overwrite verdicts that were written NULL while it was syncing
            # (ReplacingMergeTree dedups on inserted_at). When untrusted, only
            # move forward — recomputing would just re-write NULLs.
            start = (
                min(start_new, max(target - REEVAL_EPOCHS + 1, 0))
                if trustworthy
                else start_new
            )
            log.info(
                "target=%s trusted=%s processing epochs %s..%s",
                target, trustworthy, start, target,
            )
            for epoch in range(start, target + 1):
                process_epoch(epoch, genesis_time, validators, trustworthy)
        except Exception:
            log.exception("epoch processing failed; retrying next poll")
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
