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

function tryParseJsonMessage(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function applyHttpRequest(event, method, rawPath, status, bytes) {
  event.http_method = method || null;
  event.http_status = status === null || status === undefined ? null : Number(status);
  event.http_bytes = bytes === null || bytes === undefined ? null : Number(bytes);

  let pathname = rawPath || '';
  let searchParams = new URLSearchParams();
  try {
    const u = new URL(pathname, 'http://placeholder');
    pathname = u.pathname;
    searchParams = u.searchParams;
  } catch {
    // leave pathname/searchParams as-is if it doesn't parse as a URL
  }

  let m;
  if ((m = pathname.match(/^\/eth\/v[12]\/beacon\/blocks\/(\d+)$/))) {
    event.event = 'beacon_blocks_request';
    event.slot = Number(m[1]);
  } else if ((m = pathname.match(/^\/eth\/v1\/beacon\/headers\/(\d+)$/))) {
    event.event = 'beacon_headers_request';
    event.slot = Number(m[1]);
  } else if (pathname === '/eth/v1/validator/attestation_data') {
    event.event = 'att_data_request';
    const s = searchParams.get('slot');
    const c = searchParams.get('committee_index');
    if (s !== null) event.slot = Number(s);
    if (c !== null) event.committee_index = Number(c);
  } else if ((m = pathname.match(/^\/eth\/v[12]\/validator\/duties\/attester\/(\d+)$/))) {
    event.event = 'duties_attester_request';
    event.epoch = Number(m[1]);
  } else if ((m = pathname.match(/^\/eth\/v[12]\/validator\/duties\/proposer\/(\d+)$/))) {
    event.event = 'duties_proposer_request';
    event.epoch = Number(m[1]);
  } else if (pathname === '/eth/v1/validator/beacon_committee_subscriptions') {
    event.event = 'committee_subscription';
  } else if (pathname === '/eth/v1/validator/prepare_beacon_proposer') {
    event.event = 'prepare_proposer';
  } else if (/^\/eth\/v[12]\/beacon\/pool\/attestations$/.test(pathname)) {
    event.event = 'pool_attestations_submit';
  } else if (
    pathname === '/eth/v1/node/syncing' ||
    pathname === '/eth/v1/node/version' ||
    pathname === '/eth/v1/config/spec'
  ) {
    event.event = 'node_info_request';
  } else {
    event.event = 'http_other';
  }
}

const HTTP_ACCESS_LOG_RE = /"(GET|POST|PUT|DELETE) ([^\s"]+) HTTP\/[0-9.]+" (\d{3}) (\d+)/;
const HTTP_WARN_RE = /^WARN Error processing HTTP API request/;
const HTTP_PLAIN_REQUEST_RE = /^(GET|POST|PUT|DELETE)\s+(\S+)/;

function parseLogEvent(record, mapping) {
  const message = record[mapping.message] || '';
  const tsMs = normalizeTimestamp(record[mapping.timestamp], message);
  const source = record[mapping.source] || '';
  const src = classifySource(source, message);
  const slot = extractInt(message, /slot: (?:Slot\()?(\d+)/);
  const asJson = tryParseJsonMessage(message);
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
    event.epoch = extractInt(message, /[^_]epoch:\s*"?(\d+)"?/);
    event.finalized_epoch = extractInt(message, /finalized_epoch:\s*"?(\d+)"?/);
    event.exec_hash = extract(message, /exec_hash:\s*"?(0x[0-9a-fA-F]+)/);
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
  } else if (asJson && asJson.msg === 'Chain head was updated') {
    event.event = 'chain_head_updated';
    event.exec_height = num(asJson.height);
    event.exec_hash = typeof asJson.hash === 'string' ? asJson.hash : null;
  } else if (asJson && asJson.msg === 'Imported new potential chain segment') {
    event.event = 'segment_imported';
    event.exec_height = num(asJson.height);
    event.mgas = typeof asJson.mgas === 'number' ? asJson.mgas : null;
    event.txs = typeof asJson.txs === 'number' ? asJson.txs : null;
  } else if (HTTP_ACCESS_LOG_RE.test(message)) {
    const m = message.match(HTTP_ACCESS_LOG_RE);
    applyHttpRequest(event, m[1], m[2], m[3], m[4]);
  } else if (HTTP_WARN_RE.test(message)) {
    const elapsed = extract(message, /elapsed_ms:\s*([0-9.]+)/);
    event.elapsed_ms = elapsed === null ? null : Number(elapsed);
    const status = extractInt(message, /status:\s*(\d+)/);
    const path = extract(message, /path:\s*([^\s,]+)/);
    const method = extract(message, /method:\s*(\w+)/);
    applyHttpRequest(event, method || 'GET', path || '', status, null);
  } else if (HTTP_PLAIN_REQUEST_RE.test(message) && message.includes('/eth/v')) {
    const m = message.match(HTTP_PLAIN_REQUEST_RE);
    applyHttpRequest(event, m[1], m[2], null, null);
  } else if (message.includes('Connected to beacon node')) {
    event.event = 'vc_connected';
  } else if (message.includes('Listening for doppelgangers')) {
    event.event = 'doppelganger_watch';
  } else if (message.includes('Some validators active')) {
    event.event = 'validators_active';
  } else if (message.includes('Completed pruning of slashing protection DB')) {
    event.event = 'slashing_db_pruned';
  } else if (message.includes('Published validator registrations to the builder network')) {
    event.event = 'builder_registration_published';
  } else if (message.includes('Healthcheck successful') || message.includes('PROBE -> PASS')) {
    event.event = 'healthcheck';
    event.sync_hint = message.includes('in-sync') ? 'Synced' : null;
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
    slot_source: 'derived',
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

      row.epoch =
        maxEventValue(scopedEvents, 'slot_timer', 'epoch') ??
        maxEventValue(scopedEvents, 'duties_attester_request', 'epoch') ??
        maxEventValue(scopedEvents, 'duties_proposer_request', 'epoch');
      row.exec_block_number =
        maxEventValue(scopedEvents, 'chain_head_updated', 'exec_height') ??
        maxEventValue(scopedEvents, 'segment_imported', 'exec_height');
      if (row.committee_index === null) {
        const attData = scopedEvents.find(e => e.event === 'att_data_request' && e.committee_index !== undefined);
        if (attData) row.committee_index = attData.committee_index;
      }

      const blockStatusEvents = scopedEvents.filter(
        e => e.event === 'beacon_blocks_request' || e.event === 'beacon_headers_request',
      );
      if (blockStatusEvents.some(e => e.http_status === 200)) {
        row.block_on_chain = true;
      } else if (blockStatusEvents.some(e => e.http_status === 404)) {
        row.missed = true;
      }

      row.slot_source = slotEvents.some(e => !e.slot_inferred) ? 'csv' : 'derived';

      rows.push(row);
    }
  }
  return rows.sort((a, b) => (b.slot ?? 0) - (a.slot ?? 0));
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
  const ignoredSamples = [];
  const serviceCounts = {};
  let minTimestampMs = null;
  let maxTimestampMs = null;
  let ignoredRows = 0;
  for (const row of parsed.rows) {
    const service = mapping.source ? (row[mapping.source] || '') : '';
    serviceCounts[service || '(blank)'] = (serviceCounts[service || '(blank)'] || 0) + 1;
    const tsMs = normalizeTimestamp(mapping.timestamp ? row[mapping.timestamp] : '', mapping.message ? row[mapping.message] : '');
    if (Number.isFinite(tsMs)) {
      minTimestampMs = minTimestampMs === null ? tsMs : Math.min(minTimestampMs, tsMs);
      maxTimestampMs = maxTimestampMs === null ? tsMs : Math.max(maxTimestampMs, tsMs);
    }
    const event = parseLogEvent(row, mapping);
    if (event) events.push(event);
    else {
      ignoredRows++;
      if (ignoredSamples.length < 5) {
        ignoredSamples.push(String(mapping.message ? row[mapping.message] : '').slice(0, 180));
      }
    }
  }
  const slots = [...new Set(events.map(e => e.slot).filter(v => v !== null && v !== undefined))].sort((a, b) => a - b);
  const validatorIndices = [...new Set(events.map(e => e.validator_index).filter(v => v !== null && v !== undefined))].sort((a, b) => a - b);
  const validatorPubkeys = [...new Set(events.map(e => e.validator_pubkey).filter(Boolean))].sort();
  const eventCounts = {};
  for (const event of events) {
    eventCounts[event.event] = (eventCounts[event.event] || 0) + 1;
  }

  return {
    headers: parsed.headers,
    mapping,
    rows: buildDiagnosticRows(events),
    events,
    stats: {
      totalRows: parsed.rows.length,
      parsedEvents: events.length,
      ignoredRows,
      minTimestamp: minTimestampMs === null ? null : new Date(minTimestampMs).toISOString(),
      maxTimestamp: maxTimestampMs === null ? null : new Date(maxTimestampMs).toISOString(),
      minSlot: slots.length ? slots[0] : null,
      maxSlot: slots.length ? slots[slots.length - 1] : null,
      slots,
      validatorIndices,
      validatorPubkeys,
      serviceCounts,
      eventCounts,
      ignoredSamples,
    },
  };
}

function mergeCounts(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    target[key] = (target[key] || 0) + value;
  }
}

export function parseDatadogCsvFiles(files, overrides = {}) {
  const results = files.map(file => ({
    name: file.name || 'csv',
    result: parseDatadogCsv(file.text || '', overrides),
  }));
  const allEvents = results.flatMap(item => item.result.events || []);
  const rows = buildDiagnosticRows(allEvents);
  const slots = [...new Set(allEvents.map(e => e.slot).filter(v => v !== null && v !== undefined))].sort((a, b) => a - b);
  const validatorIndices = [...new Set(allEvents.map(e => e.validator_index).filter(v => v !== null && v !== undefined))].sort((a, b) => a - b);
  const validatorPubkeys = [...new Set(allEvents.map(e => e.validator_pubkey).filter(Boolean))].sort();
  const serviceCounts = {};
  const eventCounts = {};
  const ignoredSamples = [];
  let minTimestamp = null;
  let maxTimestamp = null;
  let totalRows = 0;
  let parsedEvents = 0;
  let ignoredRows = 0;

  for (const { result } of results) {
    totalRows += result.stats.totalRows || 0;
    parsedEvents += result.stats.parsedEvents || 0;
    ignoredRows += result.stats.ignoredRows || 0;
    mergeCounts(serviceCounts, result.stats.serviceCounts);
    mergeCounts(eventCounts, result.stats.eventCounts);
    for (const sample of result.stats.ignoredSamples || []) {
      if (ignoredSamples.length < 5) ignoredSamples.push(sample);
    }
    if (result.stats.minTimestamp) {
      minTimestamp = minTimestamp === null || result.stats.minTimestamp < minTimestamp
        ? result.stats.minTimestamp
        : minTimestamp;
    }
    if (result.stats.maxTimestamp) {
      maxTimestamp = maxTimestamp === null || result.stats.maxTimestamp > maxTimestamp
        ? result.stats.maxTimestamp
        : maxTimestamp;
    }
  }

  return {
    headers: results[0]?.result.headers || [],
    mapping: results[0]?.result.mapping || {},
    rows,
    events: allEvents,
    stats: {
      fileCount: files.length,
      fileNames: files.map(file => file.name || 'csv'),
      totalRows,
      parsedEvents,
      ignoredRows,
      minTimestamp,
      maxTimestamp,
      minSlot: slots.length ? slots[0] : null,
      maxSlot: slots.length ? slots[slots.length - 1] : null,
      slots,
      validatorIndices,
      validatorPubkeys,
      serviceCounts,
      eventCounts,
      ignoredSamples,
    },
  };
}
