const TIMESTAMP_HEADERS = [
  '@timestamp', 'timestamp', 'time', 'date', 'datetime', 'Timestamp', 'Time',
];
const MESSAGE_HEADERS = [
  'message', 'Message', '@message', 'content', 'log', 'event.message',
];
const SOURCE_HEADERS = [
  'service', 'Service', 'source', 'Source', 'dd.service', 'service.name',
];
const HOST_HEADERS = ['host', 'Host', 'hostname', 'Hostname'];
const STATUS_HEADERS = ['status', 'Status', 'level', 'Level', 'severity', 'Severity'];

const GENESIS_UNIX_SECONDS = 1742213400;
const SLOT_SECONDS = 12;

function firstHeader(headers, candidates) {
  const lower = new Map(headers.map(h => [h.toLowerCase(), h]));
  for (const candidate of candidates) {
    const exact = headers.find(h => h === candidate);
    if (exact) return exact;
    const ci = lower.get(candidate.toLowerCase());
    if (ci) return ci;
  }
  return '';
}

export function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      field = '';
      row = [];
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  while (rows.length && rows[rows.length - 1].every(v => v === '')) rows.pop();
  const headers = rows.shift() || [];
  return {
    headers,
    rows: rows.map(values => Object.fromEntries(headers.map((h, i) => [h, values[i] ?? '']))),
  };
}

export function detectDatadogMapping(headers) {
  return {
    timestamp: firstHeader(headers, TIMESTAMP_HEADERS),
    message: firstHeader(headers, MESSAGE_HEADERS),
    source: firstHeader(headers, SOURCE_HEADERS),
    host: firstHeader(headers, HOST_HEADERS),
    status: firstHeader(headers, STATUS_HEADERS),
  };
}

function num(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function extract(raw, regex) {
  const m = raw.match(regex);
  return m ? m[1] : null;
}

function extractInt(raw, regex) {
  const v = extract(raw, regex);
  return v === null ? null : num(v);
}

function extractMs(raw, name) {
  return extractInt(raw, new RegExp(`${name}: "?([0-9]+)"?`));
}

function normalizeTimestamp(value, message) {
  const direct = Date.parse(value || '');
  if (Number.isFinite(direct)) return direct;
  const prefix = extract(message || '', /^(\w+ +\d+ +[0-9:.]+)/);
  if (!prefix) return NaN;
  const year = new Date().getUTCFullYear();
  return Date.parse(`${prefix} ${year} UTC`);
}

function slotStartMs(slot) {
  return (GENESIS_UNIX_SECONDS + slot * SLOT_SECONDS) * 1000;
}

function slotFromTimestamp(tsMs) {
  if (!Number.isFinite(tsMs)) return null;
  return Math.floor((tsMs / 1000 - GENESIS_UNIX_SECONDS) / SLOT_SECONDS);
}

function offsetMs(tsMs, slot) {
  if (!Number.isFinite(tsMs) || slot === null || slot === undefined) return null;
  return Math.round(tsMs - slotStartMs(slot));
}

function classifySource(source, message) {
  const s = `${source || ''} ${message || ''}`.toLowerCase();
  if (s.includes('eth-staking-validator') || s.includes('validator') || s.includes('vc')) return 'validator';
  return 'beacon';
}

function extractValidatorIndex(raw) {
  const validators = raw.match(/validators:\s*\[([^\]]+)\]/);
  if (validators) {
    const first = validators[1].match(/"?(\d{5,})"?/);
    if (first) return Number(first[1]);
  }
  const direct = raw.match(/validator(?:_index)?:\s*"?(\d{5,})"?/);
  return direct ? Number(direct[1]) : null;
}

function extractSignerLatency(raw) {
  const duration = raw.match(/"duration"\s*:\s*"?(\d+)"?/);
  if (duration) return Number(duration[1]);
  const serviceTime = raw.match(/"servicetime"\s*:\s*"?(\d+)"?/);
  if (serviceTime) return Number(serviceTime[1]);
  return null;
}

function parseLogEvent(record, mapping) {
  const message = record[mapping.message] || '';
  const tsMs = normalizeTimestamp(record[mapping.timestamp], message);
  const source = record[mapping.source] || '';
  const src = classifySource(source, message);
  const slot = extractInt(message, /slot: (?:Slot\()?(\d+)/);
  const event = {
    tsMs,
    src,
    slot,
    block_root: extract(message, /(?:^|[ ,])(?:block_root|root|block): (0x[0-9a-fA-F]+)/) || '',
    detail: '',
    raw: message,
  };

  const pubkey = extract(message, /(?:voting_pubkey: "?|pubkey: |\/api\/v1\/eth2\/sign\/)(0x[0-9a-fA-F]+)"?/);
  if (pubkey) {
    event.validator_pubkey = pubkey.toLowerCase();
    event.validator_name = event.validator_pubkey;
  }
  const validatorIndex = extractValidatorIndex(message);
  if (validatorIndex !== null) event.validator_index = validatorIndex;

  if (message.includes('Slot timer')) {
    event.event = 'slot_timer';
    event.peers = extractInt(message, /peers: "?(\d+)"?/);
    event.head_slot = extractInt(message, /head_slot: (\d+)/);
    event.current_slot = extractInt(message, /current_slot: (\d+)/);
    event.sync_state = extract(message, /sync_state: (.+)$/) || '';
    event.slot = event.current_slot ?? event.slot;
  } else if (/^INFO Synced\b/.test(message) || message.includes('INFO Synced peers:')) {
    event.event = 'slot_timer';
    event.peers = extractInt(message, /Synced peers:\s*"?(\d+)"?/);
    event.current_slot = event.slot;
    event.sync_state = 'Synced';
  } else if (message.includes('Successfully verified gossip block')) {
    event.event = 'gossip_verified';
  } else if (message.includes('New block received')) {
    event.event = 'new_block';
  } else if (message.includes('Successfully verified gossip blob') ||
             message.includes('Successfully verified gossip data column')) {
    event.event = 'gossip_blob_verified';
  } else if (message.includes('Gossip block arrived late')) {
    event.event = 'gossip_late';
    event.proposer_index = extractInt(message, /proposer_index: (\d+)/);
    const delay = message.match(/block_delay: ([0-9.]+)(m?s)/);
    if (delay) {
      const value = Number(delay[1]);
      event.delay_s = delay[2] === 'ms' ? value / 1000 : value;
    }
  } else if (message.includes('Beacon block imported')) {
    event.event = 'block_imported';
    event.detail = extract(message, /block_source: (\w+)/) || '';
  } else if (message.includes('Delayed head block') || message.includes('On-time head block')) {
    event.event = 'delayed_head';
    event.proposer_index = extractInt(message, /proposer_index: (\d+)/);
    event.observed_delay_ms = extractMs(message, '[^_]observed_delay_ms');
    event.blob_delay_ms = extractMs(message, 'blob_delay_ms');
    event.consensus_time_ms = extractMs(message, 'consensus_time_ms');
    event.execution_time_ms = extractMs(message, 'execution_time_ms');
    event.available_delay_ms = extractMs(message, 'available_delay_ms');
    event.attestable_delay_ms = extractMs(message, 'attestable_delay_ms');
    event.imported_time_ms = extractMs(message, 'imported_time_ms');
    event.set_as_head_time_ms = extractMs(message, 'set_as_head_time_ms');
    event.total_delay_ms = extractMs(message, 'total_delay_ms');
  } else if (message.includes('Triggering getBlobs')) {
    event.event = 'getblobs_trigger';
  } else if (message.includes('Fetching blobs from the EL')) {
    event.event = 'blobs_fetch_el';
    event.num_expected = extractInt(message, /num_expected_blobs: (\d+)/);
  } else if (message.includes('Blobs partially received from the EL') ||
             message.includes('Blobs received from the EL')) {
    event.event = 'blobs_recv_el';
    event.num_fetched = extractInt(message, /num_fetched_blobs: (\d+)/);
    event.num_expected = extractInt(message, /num_expected_blobs: (\d+)/);
  } else if (message.includes('Gossip partial data column already processed via the EL')) {
    event.event = 'col_via_el';
  } else if (message.includes('Writing data columns to store')) {
    event.event = 'cols_stored';
    event.count = extractInt(message, /count: (\d+)/);
  } else if (message.includes('Starting attestation production')) {
    event.event = 'att_start';
  } else if (message.includes('Enabled validator')) {
    event.event = 'validator_enabled';
    event.detail = message.slice(0, 220);
  } else if (message.includes('Validator without index')) {
    event.event = 'validator_without_index';
    event.detail = message.slice(0, 220);
  } else if (message.includes('Failed to resolve pubkey to index')) {
    event.event = 'validator_index_resolution_failed';
    event.detail = message.slice(0, 300);
  } else if (message.includes('Successfully published') && message.includes('aggregate')) {
    event.event = 'agg_published';
    event.count = extractInt(message, /count: (\d+)/);
    event.detail = message.slice(0, 220);
  } else if (message.includes('Successfully published attestation')) {
    event.event = 'att_published';
    event.count = extractInt(message, /count: (\d+)/);
    event.committee_index = extractInt(message, /committee_index: (\d+)/);
    event.detail = message.slice(0, 220);
  } else if (message.includes('Successfully published attestations')) {
    event.event = 'att_published';
    event.detail = message.slice(0, 220);
  } else if (message.includes('Failed to spawn attestation tasks') ||
             message.includes('Failed to produce attestation data') ||
             message.includes('Failed to attest based on head event') ||
             message.includes('Previous epoch attestation(s) failed to match head')) {
    event.event = 'att_failed';
    event.detail = message.includes('Failed to attest based on head event')
      ? 'Failed to attest based on head event'
      : message.slice(0, 300);
  } else if (message.includes('/api/v1/eth2/sign/')) {
    event.event = 'signer_latency';
    event.signer_latency_ms = extractSignerLatency(message);
    event.detail = message.slice(0, 220);
  } else if (message.includes('Computed attestation selection proofs')) {
    event.event = 'selection_proofs';
    event.detail = message.slice(0, 220);
  } else {
    return null;
  }

  if (event.slot === null || event.slot === undefined) {
    event.slot = slotFromTimestamp(event.tsMs);
    event.slot_inferred = event.slot !== null;
  }
  return event.slot === null || event.slot === undefined ? null : event;
}

function emptyDiagnosticRow(slot, pubkey = '', validatorIndex = null) {
  return {
    epoch: null,
    slot,
    slot_start_utc: new Date(slotStartMs(slot)).toISOString().replace('.000Z', ''),
    validator_index: validatorIndex,
    validator_pubkey: pubkey,
    validator_name: pubkey,
    committee_index: null,
    committee_position: null,
    attested_head_root: null,
    attested_target_root: null,
    attested_source_root: null,
    canonical_head_root: null,
    block_root: '',
    head_correct: null,
    target_correct: null,
    source_correct: null,
    inclusion_slot: null,
    inclusion_distance: null,
    included_in_aggregate: null,
    missed: null,
    block_on_chain: null,
    proposer_index: null,
    exec_block_number: null,
    current_head_exec_block: null,
    graffiti: '',
    blob_count: null,
    head_lag_slots: null,
    block_seen_ms: null,
    gossip_late_by_ms: null,
    el_getblobs_req_ms: null,
    import_source: '',
    blobs_from_el: null,
    blobs_expected: null,
    cols_via_el: null,
    cols_stored: null,
    blobs_from_gossip: null,
    gossip_blob_arrival_ms: null,
    blob_source: null,
    blobs_ready_ms: null,
    available_ms: null,
    avail_dur_ms: null,
    attestable_ms: null,
    imported_ms: null,
    head_ready_ms: null,
    proc_start_ms: null,
    proc_decode_ms: null,
    proc_state_ms: null,
    proc_forkchoice_ms: null,
    proc_dbread_ms: null,
    proc_dbwrite_ms: null,
    proc_postexec_ms: null,
    consensus_verify_ms: null,
    el_verify_ms: null,
    import_write_ms: null,
    set_as_head_ms: null,
    bottleneck: null,
    att_start_ms: null,
    vc_publish_dur_ms: null,
    agg_published_ms: null,
    total_attestation_lifecycle_ms: null,
    att_failures: 0,
    att_fail_reason: '',
    peers: null,
    head_slot_at_tick: null,
    node_behind_slots: null,
    sync_state: '',
    subnet_id: null,
    committee_size: null,
    agg_bits_set: null,
    propagation_delay_ms: null,
    aggregator_picked: null,
    fault_attribution: 'log_preview',
  };
}

function minOffset(events, names) {
  const values = events
    .filter(e => names.includes(e.event))
    .map(e => offsetMs(e.tsMs, e.slot))
    .filter(v => v !== null);
  return values.length ? Math.min(...values) : null;
}

function maxEventValue(events, name, field) {
  const values = events
    .filter(e => e.event === name && e[field] !== undefined && e[field] !== null)
    .map(e => e[field]);
  return values.length ? values[values.length - 1] : null;
}

function eventMatchesIdentity(event, pubkey, validatorIndex) {
  if (event.validator_pubkey) return pubkey && event.validator_pubkey === pubkey;
  if (event.validator_index !== undefined && event.validator_index !== null) {
    return validatorIndex !== null && event.validator_index === validatorIndex;
  }
  return true;
}

function buildDiagnosticRows(events) {
  const bySlot = new Map();
  for (const event of events) {
    if (!bySlot.has(event.slot)) bySlot.set(event.slot, []);
    bySlot.get(event.slot).push(event);
  }

  const rows = [];
  for (const [slot, slotEvents] of bySlot) {
    slotEvents.sort((a, b) => a.tsMs - b.tsMs);
    const identities = new Map();
    for (const event of slotEvents) {
      if (event.validator_pubkey) {
        identities.set(`pubkey:${event.validator_pubkey}`, {
          pubkey: event.validator_pubkey,
          validatorIndex: event.validator_index ?? null,
        });
      } else if (event.validator_index !== undefined && event.validator_index !== null) {
        identities.set(`index:${event.validator_index}`, {
          pubkey: '',
          validatorIndex: event.validator_index,
        });
      }
    }
    const rowIdentities = identities.size ? [...identities.values()] : [{ pubkey: '', validatorIndex: null }];
    for (const identity of rowIdentities) {
      const pubkey = identity.pubkey;
      const validatorIndex = identity.validatorIndex;
      const scopedEvents = slotEvents.filter(e => eventMatchesIdentity(e, pubkey, validatorIndex));
      const row = emptyDiagnosticRow(slot, pubkey, validatorIndex);

      const delayed = scopedEvents.filter(e => e.event === 'delayed_head').at(-1);
      const slotTimer = scopedEvents.filter(e => e.event === 'slot_timer').at(-1);
      const attStart = scopedEvents.find(e => e.event === 'att_start' && eventMatchesIdentity(e, pubkey, validatorIndex));
      const attPublished = scopedEvents.find(e => e.event === 'att_published' && eventMatchesIdentity(e, pubkey, validatorIndex));
      const attFailed = scopedEvents.find(e => e.event === 'att_failed' && eventMatchesIdentity(e, pubkey, validatorIndex));
      const signerLatency = scopedEvents.find(e => e.event === 'signer_latency' && eventMatchesIdentity(e, pubkey, validatorIndex));

      row.block_seen_ms = delayed?.observed_delay_ms ?? minOffset(scopedEvents, ['gossip_verified', 'new_block']);
      row.block_root = scopedEvents.map(e => e.block_root).find(Boolean) || '';
      row.gossip_late_by_ms = maxEventValue(scopedEvents, 'gossip_late', 'delay_s');
      if (row.gossip_late_by_ms !== null) row.gossip_late_by_ms = Math.round(row.gossip_late_by_ms * 1000);
      row.gossip_blob_arrival_ms = minOffset(scopedEvents, ['gossip_blob_verified']);
      row.blobs_from_gossip = scopedEvents.filter(e => e.event === 'gossip_blob_verified').length || null;
      row.el_getblobs_req_ms = minOffset(scopedEvents, ['getblobs_trigger']);
      row.blobs_from_el = maxEventValue(scopedEvents, 'blobs_recv_el', 'num_fetched');
      row.blobs_expected =
        maxEventValue(scopedEvents, 'blobs_recv_el', 'num_expected') ??
        maxEventValue(scopedEvents, 'blobs_fetch_el', 'num_expected');
      row.cols_via_el = scopedEvents.filter(e => e.event === 'col_via_el').length || null;
      row.cols_stored = maxEventValue(scopedEvents, 'cols_stored', 'count');
      row.blobs_ready_ms = delayed?.blob_delay_ms ?? minOffset(scopedEvents, ['cols_stored']);
      row.available_ms = delayed?.available_delay_ms ?? row.blobs_ready_ms;
      row.avail_dur_ms =
        row.available_ms !== null && row.block_seen_ms !== null
          ? row.available_ms - row.block_seen_ms
          : null;
      row.attestable_ms = delayed?.attestable_delay_ms ?? row.available_ms;
      row.imported_ms = minOffset(scopedEvents, ['block_imported']) ??
        (delayed?.total_delay_ms !== undefined && delayed?.set_as_head_time_ms !== undefined
          ? delayed.total_delay_ms - delayed.set_as_head_time_ms
          : null);
      row.head_ready_ms = delayed?.total_delay_ms ?? null;
      row.consensus_verify_ms = delayed?.consensus_time_ms ?? null;
      row.el_verify_ms = delayed?.execution_time_ms ?? null;
      row.import_write_ms = delayed?.imported_time_ms ?? null;
      row.set_as_head_ms = delayed?.set_as_head_time_ms ?? null;
      row.import_source = maxEventValue(scopedEvents, 'block_imported', 'detail') || '';
      row.proposer_index = delayed?.proposer_index ?? maxEventValue(scopedEvents, 'gossip_late', 'proposer_index');

      if (slotTimer) {
        row.peers = slotTimer.peers ?? null;
        row.head_slot_at_tick = slotTimer.head_slot ?? null;
        row.sync_state = slotTimer.sync_state || '';
        row.node_behind_slots =
          row.head_slot_at_tick === null || row.head_slot_at_tick === undefined
            ? null
            : slot - row.head_slot_at_tick;
      }

      if (attStart) row.att_start_ms = offsetMs(attStart.tsMs, slot);
      if (attPublished) {
        row.committee_index = attPublished.committee_index ?? null;
        row.total_attestation_lifecycle_ms = offsetMs(attPublished.tsMs, slot);
        if (row.att_start_ms === null) row.att_start_ms = row.total_attestation_lifecycle_ms;
      }
      if (signerLatency) {
        row.att_start_ms = row.att_start_ms ?? offsetMs(signerLatency.tsMs, slot);
        row.vc_publish_dur_ms = signerLatency.signer_latency_ms ?? null;
      }
      if (row.att_start_ms !== null && row.total_attestation_lifecycle_ms !== null) {
        row.vc_publish_dur_ms = row.vc_publish_dur_ms ?? row.total_attestation_lifecycle_ms - row.att_start_ms;
      }
      row.agg_published_ms = minOffset(scopedEvents.filter(e => eventMatchesIdentity(e, pubkey, validatorIndex)), ['agg_published']);
      row.att_failures = scopedEvents.filter(e => e.event === 'att_failed' && eventMatchesIdentity(e, pubkey, validatorIndex)).length;
      row.att_fail_reason = attFailed?.detail || '';

      const hasGossip = (row.blobs_from_gossip ?? 0) > 0;
      const hasEl = (row.blobs_from_el ?? 0) > 0 || (row.cols_via_el ?? 0) > 0;
      row.blob_source = hasGossip && hasEl ? 'gossip+el' : hasGossip ? 'gossip' : hasEl ? 'el' : null;

      const stages = [
        ['propagation', row.block_seen_ms],
        ['blob_wait', row.available_ms !== null && row.block_seen_ms !== null ? row.available_ms - row.block_seen_ms : null],
        ['import', row.imported_ms !== null && row.available_ms !== null ? row.imported_ms - Math.max(row.available_ms, row.block_seen_ms ?? row.available_ms) : null],
        ['vc_publish', row.vc_publish_dur_ms],
      ].filter(([, value]) => value !== null && Number.isFinite(value));
      row.bottleneck = stages.length ? stages.sort((a, b) => b[1] - a[1])[0][0] : null;
      if (row.att_fail_reason === 'Failed to attest based on head event') {
        row.fault_attribution = 'vc_head_event_failed';
      }

      rows.push(row);
    }
  }
  return rows.sort((a, b) => (b.slot ?? 0) - (a.slot ?? 0));
}

function isBlank(value) {
  return value === null || value === undefined || value === '';
}

function csvMatchesClickhouseRow(csvRow, chRow) {
  if (csvRow.slot !== chRow.slot) return false;
  if (!isBlank(csvRow.validator_index) && !isBlank(chRow.validator_index)) {
    return Number(csvRow.validator_index) === Number(chRow.validator_index);
  }
  if (!isBlank(csvRow.validator_pubkey) && !isBlank(chRow.validator_pubkey)) {
    return csvRow.validator_pubkey === chRow.validator_pubkey;
  }
  return isBlank(csvRow.validator_index) && isBlank(csvRow.validator_pubkey);
}

function mergeOneDiagnosticsRow(chRow, csvRows) {
  const merged = { ...chRow };
  for (const csvRow of csvRows) {
    if (!csvMatchesClickhouseRow(csvRow, chRow)) continue;
    for (const [key, value] of Object.entries(csvRow)) {
      if (isBlank(value)) continue;
      if (key === 'fault_attribution' && !isBlank(merged[key]) && merged[key] !== 'unknown') continue;
      if (isBlank(merged[key])) merged[key] = value;
    }
  }
  return merged;
}

export function mergeDiagnosticsRows(clickhouseRows, csvRows) {
  if (!clickhouseRows.length) return csvRows;
  const merged = clickhouseRows.map(row => mergeOneDiagnosticsRow(row, csvRows));
  const matchedCsv = new Set();
  for (const chRow of clickhouseRows) {
    csvRows.forEach((csvRow, i) => {
      if (csvMatchesClickhouseRow(csvRow, chRow)) matchedCsv.add(i);
    });
  }
  csvRows.forEach((csvRow, i) => {
    if (!matchedCsv.has(i)) merged.push(csvRow);
  });
  return merged.sort((a, b) => (b.slot ?? 0) - (a.slot ?? 0));
}

export function parseDatadogCsv(text, overrides = {}) {
  const parsed = parseCsv(text);
  const mapping = { ...detectDatadogMapping(parsed.headers), ...overrides };
  if (!mapping.message) {
    return {
      headers: parsed.headers,
      mapping,
      rows: [],
      events: [],
      stats: { totalRows: parsed.rows.length, parsedEvents: 0, ignoredRows: parsed.rows.length },
    };
  }

  const events = [];
  let ignoredRows = 0;
  for (const row of parsed.rows) {
    const event = parseLogEvent(row, mapping);
    if (event) events.push(event);
    else ignoredRows++;
  }
  const slots = [...new Set(events.map(e => e.slot).filter(v => v !== null && v !== undefined))].sort((a, b) => a - b);
  const validatorIndices = [...new Set(events.map(e => e.validator_index).filter(v => v !== null && v !== undefined))].sort((a, b) => a - b);
  const validatorPubkeys = [...new Set(events.map(e => e.validator_pubkey).filter(Boolean))].sort();

  return {
    headers: parsed.headers,
    mapping,
    rows: buildDiagnosticRows(events),
    events,
    stats: {
      totalRows: parsed.rows.length,
      parsedEvents: events.length,
      ignoredRows,
      minSlot: slots.length ? slots[0] : null,
      maxSlot: slots.length ? slots[slots.length - 1] : null,
      slots,
      validatorIndices,
      validatorPubkeys,
    },
  };
}
