-- Attestation Monitor schema
-- Source tables (one per data layer) + joined diagnostic views.

CREATE DATABASE IF NOT EXISTS attmon;

-- Layer 1: on-chain attestation data (Chain Indexer writes here)
CREATE TABLE IF NOT EXISTS attmon.chain_attestations
(
    epoch                 UInt64,
    slot                  UInt64,
    slot_start_utc        DateTime('UTC'),
    validator_index       UInt64,
    validator_pubkey      String DEFAULT '',
    validator_name        String DEFAULT '',
    committee_index       UInt32,
    committee_position    UInt32,
    attested_head_root    String,
    attested_target_root  String,
    attested_source_root  String,
    canonical_head_root   String,
    -- Nullable: written NULL (renders "–") while the node is optimistic/syncing
    -- and its canonical view can't be trusted, so a bad canonical read never
    -- surfaces as a confident wrong ✓/✗. Re-evaluated once the node is trusted.
    head_correct          Nullable(UInt8),
    target_correct        Nullable(UInt8),
    source_correct        UInt8,
    inclusion_slot        Nullable(UInt64),
    inclusion_distance    Nullable(UInt64),
    included_in_aggregate UInt8,
    missed                UInt8,
    -- block facts for the duty slot (from beacon API)
    block_on_chain        Nullable(UInt8),      -- did a block land at the duty slot
    proposer_index        Nullable(UInt64),
    exec_block_number     Nullable(UInt64),     -- execution-layer block number
    exec_block_hash       String DEFAULT '',
    state_root            String DEFAULT '',
    graffiti              String DEFAULT '',
    blob_count            Nullable(UInt32),     -- kzg commitments in the block
    -- attestation propagation facts derivable without a p2p sentry
    subnet_id             Nullable(UInt32),     -- deterministic from (slot, committee)
    committee_size        Nullable(UInt32),
    agg_bits_set          Nullable(UInt32),     -- participants in the including aggregate
    head_lag_slots        Nullable(Int64),      -- duty_slot - slot(attested head root)
    inserted_at           DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(inserted_at)
ORDER BY (validator_index, slot);

ALTER TABLE attmon.chain_attestations
    ADD COLUMN IF NOT EXISTS validator_pubkey String DEFAULT '';
ALTER TABLE attmon.chain_attestations
    ADD COLUMN IF NOT EXISTS validator_name String DEFAULT '';
-- Existing volumes: convert the vote verdicts to Nullable in place so the
-- indexer can write NULL "unknown-while-syncing" verdicts (see CREATE above).
ALTER TABLE attmon.chain_attestations
    MODIFY COLUMN head_correct Nullable(UInt8);
ALTER TABLE attmon.chain_attestations
    MODIFY COLUMN target_correct Nullable(UInt8);

-- Layer 2: per-event node internals parsed from Lighthouse beacon + validator
-- client debug logs (Vector writes here). One row per log line of interest;
-- sparse columns are cheap in ClickHouse.
CREATE TABLE IF NOT EXISTS attmon.node_events
(
    ts                  DateTime64(3, 'UTC'),
    src                 LowCardinality(String),   -- beacon | validator
    event               LowCardinality(String),
    validator_pubkey    String DEFAULT '',
    validator_name      String DEFAULT '',
    slot                Nullable(UInt64),
    block_root          String DEFAULT '',
    proposer_index      Nullable(UInt64),
    peers               Nullable(UInt32),
    head_slot           Nullable(UInt64),
    current_slot        Nullable(UInt64),
    sync_state          String DEFAULT '',
    delay_s             Nullable(Float64),        -- gossip_late block_delay
    observed_delay_ms   Nullable(Float64),
    blob_delay_ms       Nullable(Float64),
    consensus_time_ms   Nullable(Float64),
    execution_time_ms   Nullable(Float64),
    available_delay_ms  Nullable(Float64),
    attestable_delay_ms Nullable(Float64),
    imported_time_ms    Nullable(Float64),
    set_as_head_time_ms Nullable(Float64),
    total_delay_ms      Nullable(Float64),
    num_expected        Nullable(UInt32),
    num_fetched         Nullable(UInt32),
    count               Nullable(UInt32),
    committee_index     Nullable(UInt32),
    detail              String DEFAULT '',
    inserted_at         DateTime DEFAULT now()
)
ENGINE = MergeTree
ORDER BY (event, ts);

ALTER TABLE attmon.node_events
    ADD COLUMN IF NOT EXISTS validator_pubkey String DEFAULT '';
ALTER TABLE attmon.node_events
    ADD COLUMN IF NOT EXISTS validator_name String DEFAULT '';

-- Legacy layer-2 table kept for compatibility (Delayed head block only)
CREATE TABLE IF NOT EXISTS attmon.node_logs
(
    slot                Nullable(UInt64),
    block_root          String DEFAULT '',
    block_arrival_ms    Nullable(Float64),
    block_processing_ms Nullable(Float64),
    execution_time_ms   Nullable(Float64),
    attestable_delay_ms Nullable(Float64),
    log_ts              String DEFAULT '',
    inserted_at         DateTime DEFAULT now()
)
ENGINE = MergeTree
ORDER BY inserted_at;

CREATE TABLE IF NOT EXISTS attmon.local_validators
(
    validator_index  UInt64,
    validator_pubkey String,
    validator_name   String,
    source           LowCardinality(String),
    last_seen        DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(last_seen)
ORDER BY validator_index;

-- Layer 3: P2P gossip observations (Xatu Sentry — stubbed until deployed)
CREATE TABLE IF NOT EXISTS attmon.p2p_attestations
(
    slot                 UInt64,
    validator_index      UInt64,
    validator_pubkey     String DEFAULT '',
    validator_name       String DEFAULT '',
    propagation_delay_ms Nullable(Float64),
    subnet_id            Nullable(UInt32),
    aggregator_picked    Nullable(UInt8),
    inserted_at          DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(inserted_at)
ORDER BY (validator_index, slot);

ALTER TABLE attmon.p2p_attestations
    ADD COLUMN IF NOT EXISTS validator_pubkey String DEFAULT '';
ALTER TABLE attmon.p2p_attestations
    ADD COLUMN IF NOT EXISTS validator_name String DEFAULT '';

-- ---------------------------------------------------------------------------
-- slot_timeline: one row per slot, every step as an ACTUAL offset in seconds
-- from the slot start (genesis 1742213400, 12s slots). Events that only carry
-- a block_root are attached to their slot via a root->slot map built from
-- events that carry both; events with neither fall back to the slot derived
-- from the log timestamp.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW attmon.slot_timeline AS
WITH
    1742213400 AS genesis,
    root_map AS (
        SELECT block_root, min(assumeNotNull(slot)) AS rslot
        FROM attmon.node_events
        WHERE block_root != '' AND slot IS NOT NULL
        GROUP BY block_root
    ),
    ev AS (
        SELECT
            e.ts AS ts,
            e.src AS src,
            e.event AS event,
            coalesce(
                e.slot,
                if(r.rslot = 0, NULL, r.rslot),
                toUInt64(intDiv(toUnixTimestamp(e.ts) - genesis, 12))
            ) AS slot,
            e.block_root AS block_root,
            e.peers AS peers,
            e.head_slot AS head_slot,
            e.current_slot AS current_slot,
            e.sync_state AS sync_state,
            e.delay_s AS delay_s,
            e.observed_delay_ms AS observed_delay_ms,
            e.blob_delay_ms AS blob_delay_ms,
            e.consensus_time_ms AS consensus_time_ms,
            e.execution_time_ms AS execution_time_ms,
            e.available_delay_ms AS available_delay_ms,
            e.attestable_delay_ms AS attestable_delay_ms,
            e.imported_time_ms AS imported_time_ms,
            e.set_as_head_time_ms AS set_as_head_time_ms,
            e.total_delay_ms AS total_delay_ms,
            e.num_expected AS num_expected,
            e.num_fetched AS num_fetched,
            e.count AS count,
            e.detail AS detail
        FROM attmon.node_events AS e
        LEFT JOIN root_map AS r ON r.block_root = e.block_root
    )
SELECT
    slot,
    toDateTime(genesis + slot * 12, 'UTC')                       AS slot_start_utc,
    -- block journey (seconds into the slot, actual numbers)
    minIfOrNull(toUnixTimestamp64Milli(ts), event IN ('gossip_verified', 'new_block')) / 1000.0
        - (genesis + slot * 12)                                  AS block_seen_s,
    anyIf(delay_s, event = 'gossip_late')                        AS gossip_late_by_s,
    minIfOrNull(toUnixTimestamp64Milli(ts), event = 'block_imported') / 1000.0
        - (genesis + slot * 12)                                  AS block_imported_s,
    anyIf(detail, event = 'block_imported')                      AS import_source,
    -- blob / data-column journey
    minIfOrNull(toUnixTimestamp64Milli(ts), event = 'getblobs_trigger') / 1000.0
        - (genesis + slot * 12)                                  AS el_getblobs_s,
    maxIf(num_fetched, event = 'blobs_recv_el')                  AS blobs_from_el,
    maxIf(num_expected, event IN ('blobs_fetch_el', 'blobs_recv_el')) AS blobs_expected,
    countIf(event = 'col_via_el')                                AS cols_via_el,
    minIfOrNull(toUnixTimestamp64Milli(ts), event = 'cols_stored') / 1000.0
        - (genesis + slot * 12)                                  AS data_complete_s,
    maxIf(count, event = 'cols_stored')                          AS cols_stored,
    -- blobs/data-columns that arrived via GOSSIP (vs the EL getBlobs path)
    countIf(event = 'gossip_blob_verified')                      AS blobs_from_gossip,
    minIfOrNull(toUnixTimestamp64Milli(ts), event = 'gossip_blob_verified') / 1000.0
        - (genesis + slot * 12)                                  AS gossip_blob_arrival_s,
    -- delayed-head breakdown (ms, only logged when block was late)
    maxIf(observed_delay_ms, event = 'delayed_head')             AS observed_delay_ms,
    maxIf(blob_delay_ms, event = 'delayed_head')                 AS blob_delay_ms,
    maxIf(consensus_time_ms, event = 'delayed_head')             AS consensus_time_ms,
    maxIf(execution_time_ms, event = 'delayed_head')             AS execution_time_ms,
    maxIf(available_delay_ms, event = 'delayed_head')            AS available_delay_ms,
    maxIf(attestable_delay_ms, event = 'delayed_head')           AS attestable_delay_ms,
    maxIf(imported_time_ms, event = 'delayed_head')              AS imported_time_ms,
    maxIf(set_as_head_time_ms, event = 'delayed_head')           AS set_as_head_time_ms,
    maxIf(total_delay_ms, event = 'delayed_head')                AS total_delay_ms,
    -- validator client journey
    minIfOrNull(toUnixTimestamp64Milli(ts), event = 'att_start') / 1000.0
        - (genesis + slot * 12)                                  AS att_start_s,
    minIfOrNull(toUnixTimestamp64Milli(ts), event = 'att_published') / 1000.0
        - (genesis + slot * 12)                                  AS att_published_s,
    minIfOrNull(toUnixTimestamp64Milli(ts), event = 'agg_published') / 1000.0
        - (genesis + slot * 12)                                  AS agg_published_s,
    countIf(event = 'att_failed')                                AS att_failures,
    anyIf(detail, event = 'att_failed')                          AS att_fail_reason,
    -- node health at the slot tick
    anyIf(peers, event = 'slot_timer' AND current_slot = slot)   AS peers,
    anyIf(head_slot, event = 'slot_timer' AND current_slot = slot) AS head_slot_at_tick,
    anyIf(sync_state, event = 'slot_timer' AND current_slot = slot) AS sync_state
FROM ev
WHERE slot IS NOT NULL
GROUP BY slot;

-- ---------------------------------------------------------------------------
-- Joined diagnostic view: one row per validator per duty slot.
-- join_use_nulls so missing log/p2p rows surface as NULL, not zero — the
-- fault logic depends on distinguishing "no data" from "0 ms".
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW attmon.attestation_diagnostics AS
WITH
    -- Consolidated timeline points, ms after slot start. Two log sources
    -- describe the same moments: the delayed-head ms breakdown (precise, but
    -- only logged when the block was late) and per-event log timestamps
    -- (present for every block the node saw live, absent for range-synced
    -- blocks). coalesce merges them into ONE set — whichever exists wins.
    round(coalesce(t.observed_delay_ms, t.block_seen_s * 1000))     AS x_seen_ms,
    round(coalesce(t.blob_delay_ms, t.data_complete_s * 1000))      AS x_blobs_ready_ms,
    round(coalesce(t.available_delay_ms, t.data_complete_s * 1000)) AS x_available_ms,
    round(coalesce(t.block_imported_s * 1000,
                   t.total_delay_ms - t.set_as_head_time_ms))       AS x_imported_ms,
    round((t.att_published_s - t.att_start_s) * 1000)               AS x_vc_pub_dur_ms
SELECT
    c.epoch                 AS epoch,
    c.slot                  AS slot,
    c.slot_start_utc        AS slot_start_utc,
    c.validator_index       AS validator_index,
    c.validator_pubkey      AS validator_pubkey,
    c.validator_name        AS validator_name,
    c.committee_index       AS committee_index,
    c.committee_position    AS committee_position,
    c.attested_head_root    AS attested_head_root,
    c.attested_target_root  AS attested_target_root,
    c.attested_source_root  AS attested_source_root,
    c.canonical_head_root   AS canonical_head_root,
    c.head_correct          AS head_correct,
    c.target_correct        AS target_correct,
    c.source_correct        AS source_correct,
    c.inclusion_slot        AS inclusion_slot,
    c.inclusion_distance    AS inclusion_distance,
    c.included_in_aggregate AS included_in_aggregate,
    c.missed                AS missed,
    -- block facts
    c.block_on_chain        AS block_on_chain,
    c.proposer_index        AS proposer_index,
    c.exec_block_number     AS exec_block_number,
    c.graffiti              AS graffiti,
    c.blob_count            AS blob_count,
    c.head_lag_slots        AS head_lag_slots,
    -- BLOCK TIMELINE: points in time, ms after slot start. These are wall
    -- clock OFFSETS, not durations — stages run in parallel (getBlobs fires
    -- while verification runs), so the numbers overlap and do NOT sum.
    x_seen_ms               AS block_seen_ms,
    round(t.gossip_late_by_s * 1000) AS gossip_late_by_ms,
    round(t.el_getblobs_s * 1000)    AS el_getblobs_req_ms,
    t.import_source         AS import_source,
    t.blobs_from_el         AS blobs_from_el,
    t.blobs_expected        AS blobs_expected,
    t.cols_via_el           AS cols_via_el,
    t.cols_stored           AS cols_stored,
    -- where the blobs/data columns actually came from this slot
    t.blobs_from_gossip     AS blobs_from_gossip,
    round(t.gossip_blob_arrival_s * 1000) AS gossip_blob_arrival_ms,
    multiIf(
        coalesce(t.blobs_from_gossip, 0) > 0 AND
            (coalesce(t.blobs_from_el, 0) > 0 OR coalesce(t.cols_via_el, 0) > 0), 'gossip+el',
        coalesce(t.blobs_from_gossip, 0) > 0,                                     'gossip',
        coalesce(t.blobs_from_el, 0) > 0 OR coalesce(t.cols_via_el, 0) > 0,       'el',
        c.blob_count = 0,                                                         'none',
        NULL
    )                       AS blob_source,
    x_blobs_ready_ms        AS blobs_ready_ms,
    x_available_ms          AS available_ms,
    round(coalesce(t.attestable_delay_ms, t.data_complete_s * 1000)) AS attestable_ms,
    x_imported_ms           AS imported_ms,
    round(t.total_delay_ms) AS head_ready_ms,
    -- PROCESS DURATIONS: how long each verify/import step took (ms; only
    -- logged on late blocks). Durations, not offsets.
    round(t.consensus_time_ms)   AS consensus_verify_ms,
    round(t.execution_time_ms)   AS el_verify_ms,
    round(t.imported_time_ms)    AS import_write_ms,
    round(t.set_as_head_time_ms) AS set_as_head_ms,
    -- STAGES: gaps between consecutive timeline points (ms) — Sigma Prime
    -- model: propagation → blob wait → import, then the VC's own work
    x_seen_ms                                          AS stage_propagation_ms,
    x_available_ms - x_seen_ms                         AS stage_blob_wait_ms,
    x_imported_ms - greatest(x_available_ms, x_seen_ms) AS stage_import_ms,
    -- which stage ate the most time this slot (vc_publish stage = vc_publish_dur_ms)
    multiIf(
        x_seen_ms IS NULL AND t.att_published_s IS NULL, NULL,
        coalesce(x_seen_ms, -1) >= greatest(
            coalesce(x_available_ms - x_seen_ms, -1),
            coalesce(x_imported_ms - greatest(x_available_ms, x_seen_ms), -1),
            coalesce(x_vc_pub_dur_ms, -1)),                             'propagation',
        coalesce(x_available_ms - x_seen_ms, -1) >= greatest(
            coalesce(x_imported_ms - greatest(x_available_ms, x_seen_ms), -1),
            coalesce(x_vc_pub_dur_ms, -1)),                             'blob_wait',
        coalesce(x_imported_ms - greatest(x_available_ms, x_seen_ms), -1) >=
            coalesce(x_vc_pub_dur_ms, -1),                              'import',
        'vc_publish'
    ) AS bottleneck,
    -- validator client (ms after slot start)
    round(t.att_start_s * 1000) AS att_start_ms,
    x_vc_pub_dur_ms         AS vc_publish_dur_ms,
    -- aggregation: when our node published the aggregate for this slot (ms
    -- after slot start), NULL if this validator wasn't an aggregator
    round(t.agg_published_s * 1000) AS agg_published_ms,
    -- THE end-to-end number: attestation hit gossip this long after slot
    -- start (wall clock). NULL until the VC actually published.
    round(t.att_published_s * 1000) AS total_attestation_lifecycle_ms,
    t.att_failures          AS att_failures,
    t.att_fail_reason       AS att_fail_reason,
    -- node health at the slot tick
    t.peers                 AS peers,
    t.head_slot_at_tick     AS head_slot_at_tick,
    c.slot - t.head_slot_at_tick AS node_behind_slots,
    t.sync_state            AS sync_state,
    -- propagation facts
    c.subnet_id             AS subnet_id,
    c.committee_size        AS committee_size,
    c.agg_bits_set          AS agg_bits_set,
    p.propagation_delay_ms  AS propagation_delay_ms,
    p.aggregator_picked     AS aggregator_picked,
    multiIf(
        c.missed = 1 AND t.att_failures > 0,                                     'vc_produce_failed',
        c.missed = 1 AND c.block_on_chain = 0,                                   'no_block_in_slot',
        c.missed = 1 AND coalesce(t.attestable_delay_ms, t.block_seen_s * 1000, 0) > 4000, 'block_arrived_late',
        c.missed = 1,                                                            'node_broadcast_issue',
        c.included_in_aggregate = 0 AND c.head_correct = 0,                      'wrong_head_vote',
        c.included_in_aggregate = 0 AND coalesce(p.propagation_delay_ms, 0) > 4000, 'propagation_too_slow',
        c.included_in_aggregate = 0,                                             'aggregator_missed',
        c.head_correct = 1 AND c.target_correct = 1 AND c.source_correct = 1
            AND c.inclusion_distance = 1,                                        'perfect',
        c.head_correct = 1 AND c.target_correct = 1 AND c.source_correct = 1
            AND c.inclusion_distance > 1,                                        'included_late',
        c.head_correct = 0 OR c.target_correct = 0,                              'partial_success',
        'unknown'
    ) AS fault_attribution
FROM attmon.chain_attestations AS c FINAL
LEFT JOIN attmon.slot_timeline AS t ON t.slot = c.slot
LEFT JOIN attmon.p2p_attestations AS p FINAL
    ON p.slot = c.slot AND p.validator_index = c.validator_index
SETTINGS join_use_nulls = 1;
