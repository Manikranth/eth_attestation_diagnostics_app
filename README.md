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

Monitored validators are discovered from Lighthouse validator-client logs.
Vector stores local validator pubkeys from lines such as `Enabled validator`
and the indexer resolves those pubkeys to validator indices through the beacon
API before writing per-validator diagnostics.

## How to run this

Everything except the existing Hoodi node stack lives in this folder.

```bash
# 1. Start the pipeline (ClickHouse, indexer, Vector, Prometheus)
docker compose up -d --build

# 2. Watch the indexer backfill (takes a couple of minutes per epoch)
docker compose logs -f indexer

# Reprocess one exact validator duty slot, bypassing log discovery
TARGET_SLOT=3597599 TARGET_VALIDATOR_INDEX=1454766 docker compose run --rm indexer

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

For a one-shot historical repair, set both `TARGET_SLOT` and
`TARGET_VALIDATOR_INDEX`. The indexer resolves that validator from the beacon
API, verifies the validator was assigned to that exact duty slot, reprocesses
that finalized epoch for only that validator, writes the row to ClickHouse, and
then exits. If Docker Desktop cannot mount the validator log directory, run the
built image directly with a reachable beacon URL:

```bash
docker run --rm --network eth_default \
  -e BEACON_URL=http://host.docker.internal:5052 \
  -e CLICKHOUSE_URL=http://attmon-clickhouse:8123 \
  -e CLICKHOUSE_USER=attmon \
  -e CLICKHOUSE_PASSWORD=attmon \
  -e TARGET_SLOT=3597599 \
  -e TARGET_VALIDATOR_INDEX=1454766 \
  eth-indexer
```

## Runbook: reading the UI

The UI does not hide or "blank out" successful data. A dash (`–`) means the
underlying ClickHouse value is `NULL`, empty, or not applicable for that row.
Common reasons:
- The event never happened for that slot, for example no late-block log means
  the late-block breakdown columns stay blank.
- The data source is not available for that measurement yet, for example
  sentry-only fields are shown as `n/a`.
- The node was syncing or optimistic, so head/target verdicts are intentionally
  left unknown instead of showing a false confident `✓` or `✗`.
- The validator was not an aggregator for that slot, so aggregate-publish time
  is blank.

Many timing columns are offsets from the start of the slot, not step durations.
That is why values can look repeated: `seen`, `data ready`, `imported`,
`attestable`, `head ready`, and `broadcast` are all timestamps on the same
12-second slot clock. Only columns prefixed with `st:` are sequential stage
gaps intended to be compared or summed.

### Dashboard columns

| Column | Source | Meaning |
|---|---|---|
| `epoch` | chain indexer | Epoch containing the validator duty. |
| `slot` | chain indexer | Duty slot for this validator's attestation. |
| `slot start utc` | chain indexer | UTC wall-clock start of the duty slot. |
| `validator` | chain indexer | Validator index resolved from local Lighthouse validator logs. |
| `name` | chain indexer / logs | Validator name when known, otherwise pubkey-derived identity. |
| `slot block` | beacon API | Whether a block exists at the duty slot. This is not attestation inclusion. |
| `proposer` | beacon API | Validator index that proposed the duty-slot block. |
| `exec block#` | beacon API | Execution-layer block number for the duty-slot block. |
| `duty root` | beacon API | Canonical beacon block root at the duty slot. This is the block at your slot, not necessarily the head root you voted for. |
| `current head#` | Lighthouse logs + beacon API | Execution-layer block number for the beacon node's `head@tick` slot. Blank when the slot-timer head cannot be mapped to an indexed block. |
| `blobs` | beacon API | Number of blob KZG commitments in the duty-slot block. |
| `block size` | beacon API | Serialized SSZ byte size of the duty-slot beacon block. |
| `blob size` | beacon API | Total blob payload bytes across blob sidecars for the duty-slot block. |
| `graffiti` | beacon API | Block graffiti, truncated in the UI. |
| `cmte` | beacon API | Attestation committee index. |
| `pos` | beacon API | Validator position inside that committee. |
| `head` | finalized beacon rewards API | Whether the validator received the finalized head-vote reward for the epoch. This includes timing, so a late attestation can miss head even if the attested root was canonical. |
| `tgt` | finalized beacon rewards API | Whether the validator received the finalized target-vote reward for the epoch. |
| `src` | finalized beacon rewards API | Whether the validator received the finalized source-vote reward for the epoch. |
| `voted head` | chain indexer | `attestation.data.beacon_block_root`: the actual head block root your validator voted for. |
| `canon head` | finalized beacon chain | Canonical head root for the duty slot after the inclusion window is finalized. Compare with `voted head`. |
| `head lag` | chain indexer | Duty slot minus the slot of the block root you attested to. `0` is ideal. |
| `att on chain` | chain indexer | Whether the attestation was found inside an aggregate included in a canonical block. |
| `incl slot` | chain indexer | Slot where the attestation was included on chain. |
| `incl root` | beacon API | Canonical beacon block root that included the aggregate containing your vote. |
| `incl exec#` | beacon API | Execution-layer block number for the inclusion block. |
| `dist` | chain indexer | Inclusion distance: `incl slot - duty slot`. `1` is ideal. |
| `missed` | chain indexer | `YES` when the attestation never appeared on chain. |
| `head@tick` | Lighthouse logs | Beacon node head slot at the local slot timer tick. |
| `behind` | Lighthouse logs | Duty slot minus `head@tick`; use this as the slot-level node lag. |
| `sync` | Lighthouse logs | Lighthouse sync state at the slot timer tick. |
| `seen` | Lighthouse logs | Offset from slot start when the block was first seen and verified on gossip. |
| `late by` | Lighthouse logs | Lighthouse's late-block delay duration, only present when Lighthouse logged a late block. |
| `blob src` | Lighthouse logs / beacon API | Slot-level blob/data-column evidence: `gossip`, `el`, `gossip+el`, `none`, or blank. `gossip+el` means both gossip-arrival and EL/getBlobs evidence appeared for the slot. |
| `getBlobs req` | Lighthouse logs | Offset when the beacon node requested blobs from the execution layer. |
| `blobs EL` | Lighthouse logs | Blobs fetched from execution layer as `fetched/expected`. |
| `cols EL` | Lighthouse logs | Data columns already available through the execution-layer path. |
| `gossip blob` | Lighthouse logs | Offset when the first blob/data column arrived via gossip. |
| `data ready` | Lighthouse logs | Offset when all blob/data-column requirements were satisfied. |
| `consensus` | Lighthouse logs | Consensus verification duration, mostly populated for late-block breakdowns. |
| `EL verify` | Lighthouse logs | Execution-layer verification duration, mostly populated for late-block breakdowns. |
| `imported` | Lighthouse logs | Offset when the block was imported into fork choice. |
| `import wr` | Lighthouse logs | Fork-choice import write duration, mostly populated for late-block breakdowns. |
| `import src` | Lighthouse logs | Import source, such as live gossip or range-sync backfill. |
| `set head` | Lighthouse logs | Set-as-head duration, mostly populated for late-block breakdowns. |
| `attestable` | Lighthouse logs | Offset when the beacon node considered the block/data attestable. |
| `head ready` | Lighthouse logs | Offset when the head was ready for the slot. |
| `st:propag` | derived | Sequential stage gap from slot start to first local block sighting. |
| `st:blobs` | derived | Sequential stage gap from first block sighting to data availability. |
| `st:import` | derived | Sequential stage gap from data availability to block import. |
| `bottleneck` | derived | Largest observed stage for the slot: propagation, blob wait, import, or VC publish. |
| `att start` | validator logs | Offset when the validator client started producing the attestation. |
| `sign+pub` | validator logs | Validator-client produce, sign, and publish duration. |
| `broadcast` | validator logs | Offset when the attestation was published to gossip; the end-to-end local lifecycle number. |
| `fails` | validator logs | Count of validator-client attestation production failures for that slot. |
| `fail reason` | validator logs | Failure detail when production failed. |
| `in agg` | chain indexer | Same chain inclusion signal repeated in the aggregation section. |
| `picked` | p2p watcher | Whether the local p2p watcher saw an aggregator pick up the vote. |
| `agg bits` | chain indexer | Participants in the aggregate that carried this vote, shown as `set/committee_size`. |
| `agg pub` | Lighthouse logs | Offset when our node published an aggregate; blank when this validator was not aggregating. |
| `peers` | Lighthouse logs | Node-wide peer count at the slot tick. This is a proxy, not per-subnet peer count. |
| `Δ blk` | deferred | Not available yet; requires a sentry view of the aggregator's block choice. |
| `propag` | p2p watcher | Time from slot start until the p2p watcher first saw this attestation on gossip. |
| `subnet` | chain indexer | Deterministic attestation gossip subnet for the duty. |
| `seen by` | deferred | Not available yet; requires sentry peer attribution. |
| `fault` | derived | First-match fault classification from `attestation_diagnostics`. |

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
.env                      knobs: backfill depth, log path
clickhouse/init/          schema: 3 tables + attestation_diagnostics view
indexer/                  Python chain indexer (beacon REST -> ClickHouse)
app/                      Python CLI (ClickHouse view -> rich table / JSON)
web/                      live dashboard on http://localhost:8080
vector/vector.yaml        log tail + regex parse -> ClickHouse
prometheus/prometheus.yml scrapes hoodi-lighthouse:5054
```

## What's easy vs hard to change

Easy: backfill depth (`.env`), table styling (`app/attmon.py`),
fault thresholds (the `multiIf` in `clickhouse/init/01_tables.sql` — edit and
rerun the `CREATE OR REPLACE VIEW` statement).

Complex: attestation decoding in `indexer/indexer.py` (Electra
`committee_bits` layout), swapping Lighthouse for another client (log parsing
regex is Lighthouse-specific).
