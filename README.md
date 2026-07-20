# Attestation Monitor

Diagnoses why validator attestations succeed or fail on Hoodi. Joins three
data layers in ClickHouse and renders a per-attestation diagnostic table with
fault attribution.

```
Lighthouse beacon + validator debug logs
                      --[Vector tails files]------> ClickHouse (node_events)
Beacon REST API       --[Chain Indexer polls]-----> ClickHouse (chain_attestations)
P2P gossipsub         --[Xatu Sentry — stubbed]---> ClickHouse (p2p_attestations)
Lighthouse /metrics   --[Prometheus scrapes]------> Prometheus

ClickHouse views:
  attmon.slot_timeline            every step per slot, actual seconds-into-slot
  attmon.attestation_diagnostics  one joined row per duty slot (dashboard/CLI)
```

Monitored validator: **1454096** (change `VALIDATOR_INDICES` in `.env`,
comma-separated for multiple).

## How to run this

Everything except the existing Hoodi node stack lives in this folder.

```bash
# 1. Start the pipeline (ClickHouse, indexer, Vector, Prometheus)
docker compose up -d --build

# 2. Watch the indexer backfill (takes a couple of minutes per epoch)
docker compose logs -f indexer

# 3. Open the live dashboard in your browser
open http://localhost:8080
#    - one flat row per duty slot, EVERY step as a column, newest first
#    - actual times: seconds into the slot (ms shown when < 1s), plus step
#      durations — block seen on gossip, getBlobs->EL, blobs from EL,
#      data ready, imported (+source), late-block ms breakdown, VC att
#      start / publish / sign+publish duration / failure reason, peers,
#      head-at-tick, how far the node was behind
#    - refreshes every 12 s; epoch selector + pause; fault chips on top
#    - lag vs chain: ~2 epochs by design (epoch E is judgeable only once
#      epoch E+1 is over — the attestation inclusion window)

# 4. Or render the table in the terminal
docker compose run --rm app --last 5          # last 5 epochs
docker compose run --rm app --wide            # all 25 columns
docker compose run --rm app --from-epoch 110120 --to-epoch 110125
docker compose run --rm app --live            # re-render every 30s
docker compose run --rm app --json -          # JSON to stdout
docker compose run --rm app --json /tmp/out.json
```

ClickHouse is on `localhost:8123` (user/pass `attmon`/`attmon`),
Prometheus UI on `localhost:9090`.

## Operator notes

### Lighthouse debug logs — already working, every slot
Lighthouse writes debug-level logs by default — no flag changes needed.
Vector tails two files (read-only mounts):
- beacon: `/Volumes/geth/hoodi_node/lighthouse/hoodi/beacon/logs/beacon.log`
- validator client: `/Volumes/geth/hoodi_node/lighthouse/hoodi/validators/logs/validator.log`

Parsed per slot into `attmon.node_events`: block seen/verified on gossip,
gossip-late flag with the exact delay, block imported (+source), getBlobs
requests to the EL, blobs/data-columns received (EL vs gossip), data
availability complete, the full `Delayed head block` ms breakdown when a
block is late, per-slot peer count + head slot + sync state (`Slot timer`
line), VC attestation production start / publish / failure reason.

If the log ever goes missing, these are the relevant Lighthouse flags:
`--logfile-debug-level debug --logfile-max-size 200 --logfile-max-number 5`.

### Prometheus metrics — needs one flag change
The beacon node currently runs **without** metrics. To light up the
Prometheus layer, add to the `lighthouse bn` command in the node's
docker-compose and restart it:

```
--metrics --metrics-address 0.0.0.0 --metrics-port 5054
```

Until then the Prometheus target is DOWN — harmless, it's a secondary layer.

### P2P layer — live (attmon-p2pwatch)
`p2p/p2p_watch.py` subscribes to the beacon node's SSE event stream
(`/eth/v1/events?topics=attestation,single_attestation`) and writes to
`attmon.p2p_attestations` whenever OUR validators' attestations are seen on
gossip:
- `propagation_delay_ms` — ms from slot start until first sighting
- `subnet_id` — attestation subnet (deterministic from slot + committee)
- `aggregator_picked` — 0 seen unaggregated, 1 seen inside an aggregate
  (our bit tested against committee_bits/aggregation_bits)

This replaces the previously-planned Xatu Sentry — same measurement (own
wall clock at event receipt), no extra schema translation. Limitation vs a
real sentry fleet: single vantage point (our own node), and the aggregator's
peer identity is still not visible — only THAT an aggregate picked us up.

## Fault attribution (column 25)

First match wins:

| Label | Meaning |
|---|---|
| `block_arrived_late` | Missed, and block reached our node after the 4s deadline — not our fault |
| `node_broadcast_issue` | Missed, but node had the block in time — our node failed to broadcast |
| `wrong_head_vote` | Not aggregated; we voted a wrong head |
| `propagation_too_slow` | Not aggregated; attestation hit the network too late (needs Xatu) |
| `aggregator_missed` | Not aggregated; nothing wrong on our end |
| `perfect` | All votes correct, inclusion distance 1 |
| `included_late` | All votes correct, inclusion distance > 1 |
| `partial_success` | Included with wrong head/target vote |

## Layout

```
docker-compose.yml        orchestration (joins external network hoodi_node_default)
.env                      knobs: validator indices, backfill depth, log path
clickhouse/init/          schema: 3 tables + attestation_diagnostics view
indexer/                  Python chain indexer (beacon REST -> ClickHouse)
app/                      Python CLI (ClickHouse view -> rich table / JSON)
web/                      live dashboard on http://localhost:8080
vector/vector.yaml        log tail + regex parse -> ClickHouse
prometheus/prometheus.yml scrapes hoodi-lighthouse:5054
```

## What's easy vs hard to change

Easy: validator list, backfill depth (`.env`), table styling (`app/attmon.py`),
fault thresholds (the `multiIf` in `clickhouse/init/01_tables.sql` — edit and
rerun the `CREATE OR REPLACE VIEW` statement).

Complex: attestation decoding in `indexer/indexer.py` (Electra
`committee_bits` layout), swapping Lighthouse for another client (log parsing
regex is Lighthouse-specific).
