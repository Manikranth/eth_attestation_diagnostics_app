"""Column spec for the charts dashboard — mirrors the sections and columns
rendered in web/index.html's table, in the same order, so every slot of
information in the table gets a matching chart here.

kind drives which figure builder runs (see figures.py):
  bool  -> 0/1/null colored status strip (green/red/gray)
  cat   -> categorical colored status strip (one color per distinct string)
  num   -> bar chart of the raw value
  ms    -> bar chart of the raw value, ms unit, red/amber threshold lines
"""

SECTIONS = [
    ("CHAIN", [
        ("validator_index", "validator", "num"),
    ]),
    ("BLOCK @ DUTY SLOT", [
        ("block_on_chain", "on chain", "bool"),
        ("proposer_index", "proposer", "num"),
        ("exec_block_number", "exec block#", "num"),
        ("current_head_exec_block", "current head#", "num"),
        ("head_lag_slots", "head lag", "num"),
        ("blob_count", "blobs", "num"),
        ("graffiti", "graffiti", "cat"),
    ]),
    ("VOTES", [
        ("head_correct", "head", "bool"),
        ("target_correct", "target", "bool"),
        ("source_correct", "source", "bool"),
    ]),
    ("INCLUSION", [
        ("inclusion_slot", "incl slot", "num"),
        ("inclusion_distance", "incl distance", "num"),
        ("missed", "missed", "bool"),
    ]),
    ("NODE", [
        ("head_slot_at_tick", "head@tick", "num"),
        ("node_behind_slots", "behind", "num"),
        ("sync_state", "sync", "cat"),
    ]),
    ("RECEIVE · BN", [
        ("available_ms", "block available", "ms"),
        ("avail_dur_ms", "available duration", "ms"),
        ("block_seen_ms", "block arrival", "ms"),
        ("gossip_late_by_ms", "gossip late by", "ms"),
    ]),
    ("BLOCK PROCESSING", [
        ("block_processing_ms", "block proc", "ms"),
    ]),
    ("BLOBS / DATA", [
        ("blob_source", "blob src", "cat"),
        ("gossip_blob_arrival_ms", "blob arrival", "ms"),
        ("blobs_from_el", "blobs from EL", "num"),
        ("blobs_expected", "blobs expected", "num"),
        ("cols_via_el", "cols via EL", "num"),
        ("blobs_ready_ms", "blob verify", "ms"),
    ]),
    ("VERIFY + IMPORT", [
        ("consensus_verify_ms", "BN consensus", "ms"),
        ("el_verify_ms", "EL verify", "ms"),
        ("imported_ms", "block import", "ms"),
        ("import_write_ms", "import write", "ms"),
        ("head_ready_ms", "head import", "ms"),
        ("set_as_head_ms", "set as head", "ms"),
    ]),
    ("VALIDATOR CLIENT", [
        ("att_start_ms", "VC att start", "ms"),
        ("vc_publish_dur_ms", "sign + pub", "ms"),
        ("att_failures", "VC fails", "num"),
        ("att_fail_reason", "VC fail reason", "cat"),
        ("bottleneck", "bottleneck", "cat"),
    ]),
    ("AGGREGATION", [
        ("included_in_aggregate", "in agg", "bool"),
        ("aggregator_picked", "picked", "bool"),
        ("committee_index", "cmts", "num"),
        ("committee_position", "pos", "num"),
        ("agg_bits_set", "agg bits", "num"),
        ("committee_size", "cmte size", "num"),
        ("agg_published_ms", "agg pub", "ms"),
        ("peers", "peer", "num"),
    ]),
    ("PROPAGATION", [
        ("propagation_delay_ms", "propag", "ms"),
        ("subnet_id", "subnet", "num"),
    ]),
    ("VERDICT", [
        ("fault_attribution", "fault", "cat"),
    ]),
]

ALL_COLUMNS = [c for _, cols in SECTIONS for c in cols]
SELECT_FIELDS = ["epoch", "slot", "slot_start_utc", "validator_index"] + [
    c[0] for c in ALL_COLUMNS if c[0] != "validator_index"
]
