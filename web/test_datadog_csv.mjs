import test from 'node:test';
import assert from 'node:assert/strict';

import * as datadogCsv from './datadog_csv.mjs';
import {
  parseCsv,
  detectDatadogMapping,
  parseDatadogCsv,
  parseDatadogCsvFiles,
  enrichRowsWithChainData,
} from './datadog_csv.mjs';

test('parseCsv handles quoted commas and embedded newlines', () => {
  const csv = [
    'timestamp,message,service',
    '"2026-07-28T12:00:00.000Z","Slot timer, slot: 10","beacon"',
    '"2026-07-28T12:00:01.000Z","line one',
    'line two","validator"',
  ].join('\n');

  const parsed = parseCsv(csv);

  assert.deepEqual(parsed.headers, ['timestamp', 'message', 'service']);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0].message, 'Slot timer, slot: 10');
  assert.equal(parsed.rows[1].message, 'line one\nline two');
});

test('detectDatadogMapping recognizes common Datadog export headers', () => {
  const mapping = detectDatadogMapping([
    '@timestamp',
    'Message',
    'Service',
    'Host',
    'Status',
  ]);

  assert.equal(mapping.timestamp, '@timestamp');
  assert.equal(mapping.message, 'Message');
  assert.equal(mapping.source, 'Service');
  assert.equal(mapping.host, 'Host');
  assert.equal(mapping.status, 'Status');
});

test('detectDatadogMapping recognizes the real Datadog CSV contract', () => {
  const mapping = detectDatadogMapping(['Date', 'Host', 'Service', 'Content']);

  assert.equal(mapping.timestamp, 'Date');
  assert.equal(mapping.message, 'Content');
  assert.equal(mapping.source, 'Service');
  assert.equal(mapping.host, 'Host');
});

test('parseDatadogCsv maps Lighthouse logs into diagnostics-shaped rows', () => {
  const csv = [
    '@timestamp,Message,Service',
    '2026-07-28T12:00:00.000Z,"Jul 28 12:00:00.000 INFO Slot timer, slot: 3585550, head_slot: 3585548, current_slot: 3585550, peers: ""65"", sync_state: Synced",lighthouse-bn',
    '2026-07-28T12:00:02.000Z,"Jul 28 12:00:02.000 INFO Successfully verified gossip block, slot: 3585550, block_root: 0xabc",lighthouse-bn',
    '2026-07-28T12:00:03.000Z,"Jul 28 12:00:03.000 INFO On-time head block, slot: 3585550, proposer_index: 44, observed_delay_ms: 2000, blob_delay_ms: 3000, consensus_time_ms: 20, execution_time_ms: 30, available_delay_ms: 3100, imported_time_ms: 120, set_as_head_time_ms: 15, total_delay_ms: 3300",lighthouse-bn',
    '2026-07-28T12:00:04.000Z,"Jul 28 12:00:04.000 INFO Starting attestation production, slot: 3585550, voting_pubkey: ""0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa""",validator',
    '2026-07-28T12:00:04.500Z,"Jul 28 12:00:04.500 INFO Successfully published attestation, slot: 3585550, committee_index: 12, voting_pubkey: ""0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa""",validator',
  ].join('\n');

  const result = parseDatadogCsv(csv);

  assert.equal(result.stats.totalRows, 5);
  assert.equal(result.stats.parsedEvents, 5);
  assert.equal(result.rows.length, 1);

  const row = result.rows[0];
  assert.equal(row.slot, 3585550);
  assert.equal(row.validator_pubkey, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(row.validator_index, null);
  assert.equal(row.block_seen_ms, 2000);
  assert.equal(row.available_ms, 3100);
  assert.equal(row.consensus_verify_ms, 20);
  assert.equal(row.el_verify_ms, 30);
  assert.equal(row.att_start_ms, 4000);
  assert.equal(row.vc_publish_dur_ms, 500);
  assert.equal(row.head_slot_at_tick, 3585548);
  assert.equal(row.node_behind_slots, 2);
  assert.equal(row.peers, 65);
  assert.equal(row.sync_state, 'Synced');
  assert.equal(row.fault_attribution, 'log_preview');
});

test('parseDatadogCsv counts unsupported rows without failing import', () => {
  const csv = [
    'timestamp,message,service',
    '2026-07-28T12:00:00.000Z,"INFO unrelated geth message",geth',
  ].join('\n');

  const result = parseDatadogCsv(csv);

  assert.equal(result.stats.totalRows, 1);
  assert.equal(result.stats.parsedEvents, 0);
  assert.equal(result.stats.ignoredRows, 1);
  assert.deepEqual(result.rows, []);
});

test('parseDatadogCsv maps real Datadog beacon rows from Date Service Content', () => {
  const csv = [
    'Date,Host,Service,Content',
    '2026-07-29T04:56:54.349Z,redacted-host,eth-staking,"INFO Synced peers: ""200"", finalized_epoch: 112207, epoch: 112207, block: ""0xabcd"", slot: 3590634"',
    '2026-07-29T04:56:37.339Z,redacted-host,eth-staking,"INFO New block received slot: 3590633, root: 0x1234abcd"',
  ].join('\n');

  const result = parseDatadogCsv(csv);

  assert.equal(result.stats.totalRows, 2);
  assert.equal(result.stats.parsedEvents, 2);
  assert.equal(result.stats.serviceCounts['eth-staking'], 2);
  assert.equal(result.stats.eventCounts.slot_timer, 1);
  assert.equal(result.stats.eventCounts.new_block, 1);
  assert.equal(result.stats.minTimestamp, '2026-07-29T04:56:37.339Z');
  assert.equal(result.stats.maxTimestamp, '2026-07-29T04:56:54.349Z');
  assert.equal(result.rows.length, 2);

  const synced = result.rows.find(r => r.slot === 3590634);
  assert.equal(synced.peers, 200);
  assert.equal(synced.sync_state, 'Synced');
  assert.equal(synced.head_slot_at_tick, null);

  const block = result.rows.find(r => r.slot === 3590633);
  assert.equal(block.block_seen_ms, 1339);
  assert.equal(block.block_root, '0x1234abcd');
  assert.equal(block.fault_attribution, 'log_preview');
});

test('parseDatadogCsv maps validator failures and publish rows by inferred slot', () => {
  const csv = [
    'Date,Host,Service,Content',
    '2026-07-29T05:18:38.619Z,redacted-host,eth-staking-validator,"Successfully published attestations validators: [""12345"",""23456""]"',
    '2026-07-29T05:18:50.203Z,redacted-host,eth-staking-validator,"Failed to attest based on head event validators: [""12345""]"',
  ].join('\n');

  const result = parseDatadogCsv(csv);

  assert.equal(result.stats.parsedEvents, 2);
  assert.equal(result.stats.minSlot, 3590743);
  assert.equal(result.stats.maxSlot, 3590744);
  assert.deepEqual(result.stats.validatorIndices, [12345]);
  assert.equal(result.rows.length, 2);

  const published = result.rows.find(r => r.slot === 3590743);
  assert.equal(published.validator_index, 12345);
  assert.equal(published.att_start_ms, 2619);
  assert.equal(published.total_attestation_lifecycle_ms, 2619);
  assert.equal(published.fault_attribution, 'log_preview');

  const failed = result.rows.find(r => r.slot === 3590744);
  assert.equal(failed.validator_index, 12345);
  assert.equal(failed.att_failures, 1);
  assert.equal(failed.att_fail_reason, 'Failed to attest based on head event');
  assert.equal(failed.fault_attribution, 'vc_head_event_failed');
});

test('parseDatadogCsv maps signer pubkey and signer latency', () => {
  const csv = [
    'Date,Host,Service,Content',
    '2026-07-29T05:18:50.203Z,redacted-host,eth-staking-validator,"{""RequestPath"":""/api/v1/eth2/sign/0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"",""duration"":54}"',
    '2026-07-29T05:19:02.203Z,redacted-host,eth-staking-validator,"{""RequestPath"":""/api/v1/eth2/sign/0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"",""servicetime"":""77""}"',
  ].join('\n');

  const result = parseDatadogCsv(csv);

  assert.equal(result.stats.parsedEvents, 2);
  const first = result.rows.find(r => r.validator_pubkey.startsWith('0xbb'));
  assert.equal(first.slot, 3590744);
  assert.equal(first.att_start_ms, 2203);
  assert.equal(first.vc_publish_dur_ms, 54);
  assert.equal(first.bottleneck, 'vc_publish');

  const second = result.rows.find(r => r.validator_pubkey.startsWith('0xcc'));
  assert.equal(second.vc_publish_dur_ms, 77);
});

test('datadog_csv.mjs no longer exports any ClickHouse-merge function (Datadog tab must be CSV-only)', () => {
  assert.equal('mergeDiagnosticsRows' in datadogCsv, false);
  assert.equal('csvMatchesClickhouseRow' in datadogCsv, false);
  assert.equal('mergeOneCsvRow' in datadogCsv, false);
});

test('parseDatadogCsv/parseDatadogCsvFiles never perform network I/O (no ClickHouse leakage possible)', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = () => {
    fetchCalled = true;
    throw new Error('parseDatadogCsv must never call fetch');
  };
  try {
    const csv = [
      'Date,Host,Service,Content',
      '2026-07-29T04:56:37.339Z,redacted-host,eth-staking,"INFO New block received slot: 3590633, root: 0x1234abcd"',
    ].join('\n');
    parseDatadogCsv(csv);
    parseDatadogCsvFiles([{ name: 'a.csv', text: csv }]);
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('parseDatadogCsv extracts epoch/finalized_epoch/exec_hash from Synced peers line', () => {
  const csv = [
    'Date,Host,Service,Content',
    '2026-07-29T06:50:26.000Z,redacted-host,eth-staking,"INFO Synced peers: ""195"", exec_hash: ""0xdeadbeef (verified)"", finalized_epoch: 112223, epoch: 112225, slot: 3591201"',
  ].join('\n');

  const result = parseDatadogCsv(csv);

  assert.equal(result.stats.parsedEvents, 1);
  const row = result.rows.find(r => r.slot === 3591201);
  assert.equal(row.peers, 195);
  assert.equal(row.sync_state, 'Synced');
  assert.equal(row.epoch, 112225);
});

test('parseDatadogCsv derives block_on_chain=true from a 200 beacon blocks access-log line', () => {
  const csv = [
    'Date,Host,Service,Content',
    '2026-07-29T06:50:26.000Z,redacted-host,eth-staking,"1.2.3.4 - - [29/Jul/2026:06:50:26 +0000] ""GET /eth/v2/beacon/blocks/3349629 HTTP/1.1"" 200 186350 ""-"" ""-"" ""-"""',
  ].join('\n');

  const result = parseDatadogCsv(csv);

  assert.equal(result.stats.parsedEvents, 1);
  const row = result.rows.find(r => r.slot === 3349629);
  assert.ok(row, 'expected a row for slot 3349629');
  assert.equal(row.block_on_chain, true);
});

test('parseDatadogCsv derives missed=true from a 404 beacon blocks access-log line', () => {
  const csv = [
    'Date,Host,Service,Content',
    '2026-07-29T06:50:11.000Z,redacted-host,eth-staking,"1.2.3.4 - - [29/Jul/2026:06:50:11 +0000] ""GET /eth/v2/beacon/blocks/3349600 HTTP/1.1"" 404 81 ""-"" ""-"" ""-"""',
  ].join('\n');

  const result = parseDatadogCsv(csv);

  assert.equal(result.stats.parsedEvents, 1);
  const row = result.rows.find(r => r.slot === 3349600);
  assert.ok(row, 'expected a row for slot 3349600');
  assert.equal(row.missed, true);
  assert.equal(row.block_on_chain, null);
});

test('parseDatadogCsv derives missed=true from a WARN 404 Not Found line for a blocks path', () => {
  const csv = [
    'Date,Host,Service,Content',
    '2026-07-29T06:50:11.000Z,redacted-host,eth-staking,"WARN Error processing HTTP API request elapsed_ms: 12.268008, status: 404 Not Found, path: /eth/v2/beacon/blocks/3349609, method: GET"',
  ].join('\n');

  const result = parseDatadogCsv(csv);

  assert.equal(result.stats.parsedEvents, 1);
  const row = result.rows.find(r => r.slot === 3349609);
  assert.ok(row, 'expected a row for slot 3349609');
  assert.equal(row.missed, true);
});

test('parseDatadogCsv extracts slot+committee_index from an attestation_data query', () => {
  const csv = [
    'Date,Host,Service,Content',
    '2026-07-29T06:50:26.000Z,redacted-host,eth-staking,"GET /eth/v1/validator/attestation_data?slot=3591202&committee_index=0"',
  ].join('\n');

  const result = parseDatadogCsv(csv);

  assert.equal(result.stats.parsedEvents, 1);
  const row = result.rows.find(r => r.slot === 3591202);
  assert.ok(row, 'expected a row for slot 3591202');
  assert.equal(row.committee_index, 0);
});

test('parseDatadogCsv extracts exec_block_number from geth chain-head-updated JSON', () => {
  const csv = [
    'Date,Host,Service,Content',
    '2026-07-29T06:50:26.000Z,redacted-host,eth-staking,"{""msg"":""Chain head was updated"",""height"":3309408,""hash"":""0xexechash""}"',
  ].join('\n');

  const result = parseDatadogCsv(csv);

  assert.equal(result.stats.parsedEvents, 1);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].exec_block_number, 3309408);
});

test('parseDatadogCsv recognizes VC status lines with no slot as identity-less, timestamp-derived rows', () => {
  const csv = [
    'Date,Host,Service,Content',
    '2026-07-29T05:51:06.001Z,redacted-host,eth-staking-validator,"Connected to beacon node(s)"',
    '2026-07-29T05:51:07.001Z,redacted-host,eth-staking-validator,"Listening for doppelgangers"',
    '2026-07-29T05:51:08.001Z,redacted-host,eth-staking-validator,"Some validators active"',
  ].join('\n');

  const result = parseDatadogCsv(csv);

  assert.equal(result.stats.parsedEvents, 3);
  assert.equal(result.stats.eventCounts.vc_connected, 1);
  assert.equal(result.stats.eventCounts.doppelganger_watch, 1);
  assert.equal(result.stats.eventCounts.validators_active, 1);
  // no literal slot in any of these lines -> slot must be derived from timestamp, never left null
  for (const row of result.rows) {
    assert.ok(Number.isInteger(row.slot));
  }
});

test('parseDatadogCsv handles an empty CSV without crashing', () => {
  const result = parseDatadogCsv('');
  assert.equal(result.stats.totalRows, 0);
  assert.equal(result.stats.parsedEvents, 0);
  assert.deepEqual(result.rows, []);
});

test('parseDatadogCsv handles a CSV with no recognizable message/timestamp headers', () => {
  const csv = [
    'foo,bar,baz',
    '1,2,3',
    '4,5,6',
  ].join('\n');

  const result = parseDatadogCsv(csv);

  assert.equal(result.mapping.message, '');
  assert.equal(result.stats.totalRows, 2);
  assert.equal(result.stats.parsedEvents, 0);
  assert.equal(result.stats.ignoredRows, 2);
  assert.deepEqual(result.rows, []);
});

test('parseDatadogCsv drops a row with a malformed timestamp and no literal slot, without crashing', () => {
  const csv = [
    'Date,Host,Service,Content',
    'not-a-real-timestamp,redacted-host,eth-staking-validator,"Connected to beacon node(s)"',
  ].join('\n');

  assert.doesNotThrow(() => parseDatadogCsv(csv));
  const result = parseDatadogCsv(csv);
  assert.equal(result.stats.totalRows, 1);
  assert.equal(result.stats.parsedEvents, 0);
  assert.equal(result.stats.ignoredRows, 1);
});

test('parseDatadogCsv leaves validator_index/validator_pubkey null (not undefined) when identity is absent', () => {
  const csv = [
    'Date,Host,Service,Content',
    '2026-07-29T06:50:26.000Z,redacted-host,eth-staking,"INFO New block received slot: 3591300, root: 0xdeadbeef"',
  ].join('\n');

  const result = parseDatadogCsv(csv);
  const row = result.rows.find(r => r.slot === 3591300);
  assert.ok(row);
  assert.equal(row.validator_index, null);
  assert.equal(row.validator_pubkey, '');
  for (const [key, value] of Object.entries(row)) {
    assert.notEqual(value, undefined, `field ${key} must be null, not undefined, when unavailable`);
  }
});

test('parseDatadogCsv counts duplicate identical log lines without crashing or silently dropping them', () => {
  const csv = [
    'Date,Host,Service,Content',
    '2026-07-29T05:18:38.619Z,redacted-host,eth-staking-validator,"Failed to attest based on head event validators: [""12345""]"',
    '2026-07-29T05:18:38.619Z,redacted-host,eth-staking-validator,"Failed to attest based on head event validators: [""12345""]"',
  ].join('\n');

  const result = parseDatadogCsv(csv);
  assert.equal(result.stats.parsedEvents, 2);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].att_failures, 2);
});

test('parseDatadogCsv aggregates multiple distinct log patterns for one slot into a single row', () => {
  const csv = [
    'Date,Host,Service,Content',
    '2026-07-29T06:50:24.000Z,redacted-host,eth-staking,"INFO New block received slot: 3591400, root: 0xfeedface"',
    '2026-07-29T06:50:25.000Z,redacted-host,eth-staking,"INFO Synced peers: ""150"", exec_hash: ""0xaaaa (verified)"", finalized_epoch: 112300, epoch: 112301, slot: 3591400"',
    '2026-07-29T06:50:26.000Z,redacted-host,eth-staking,"1.2.3.4 - - [29/Jul/2026:06:50:26 +0000] ""GET /eth/v2/beacon/blocks/3591400 HTTP/1.1"" 200 100000 ""-"" ""-"" ""-"""',
  ].join('\n');

  const result = parseDatadogCsv(csv);
  assert.equal(result.stats.parsedEvents, 3);
  assert.equal(result.rows.length, 1);
  const row = result.rows[0];
  assert.equal(row.block_root, '0xfeedface');
  assert.equal(row.peers, 150);
  assert.equal(row.sync_state, 'Synced');
  assert.equal(row.epoch, 112301);
  assert.equal(row.block_on_chain, true);
});

test('parseDatadogCsv produces separate rows for multiple distinct validators in the same slot', () => {
  const csv = [
    'Date,Host,Service,Content',
    '2026-07-29T05:18:38.000Z,redacted-host,eth-staking-validator,"Successfully published attestation, slot: 3591500, committee_index: 1, voting_pubkey: ""0xaaaa000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"""',
    '2026-07-29T05:18:38.500Z,redacted-host,eth-staking-validator,"Successfully published attestation, slot: 3591500, committee_index: 2, voting_pubkey: ""0xbbbb000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"""',
  ].join('\n');

  const result = parseDatadogCsv(csv);
  const rowsForSlot = result.rows.filter(r => r.slot === 3591500);
  assert.equal(rowsForSlot.length, 2);
  const pubkeys = rowsForSlot.map(r => r.validator_pubkey).sort();
  assert.deepEqual(pubkeys, [
    '0xaaaa000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
    '0xbbbb000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
  ]);
});

test('parseDatadogCsv produces identical results regardless of row order (out-of-order timestamps)', () => {
  const inOrder = [
    'Date,Host,Service,Content',
    '2026-07-29T05:18:38.000Z,redacted-host,eth-staking-validator,"Starting attestation production, slot: 3591600, voting_pubkey: ""0xcccc000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"""',
    '2026-07-29T05:18:38.500Z,redacted-host,eth-staking-validator,"Successfully published attestation, slot: 3591600, committee_index: 3, voting_pubkey: ""0xcccc000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"""',
  ].join('\n');
  const outOfOrder = [
    'Date,Host,Service,Content',
    '2026-07-29T05:18:38.500Z,redacted-host,eth-staking-validator,"Successfully published attestation, slot: 3591600, committee_index: 3, voting_pubkey: ""0xcccc000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"""',
    '2026-07-29T05:18:38.000Z,redacted-host,eth-staking-validator,"Starting attestation production, slot: 3591600, voting_pubkey: ""0xcccc000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"""',
  ].join('\n');

  const a = parseDatadogCsv(inOrder).rows[0];
  const b = parseDatadogCsv(outOfOrder).rows[0];
  assert.equal(a.att_start_ms, b.att_start_ms);
  assert.equal(a.total_attestation_lifecycle_ms, b.total_attestation_lifecycle_ms);
});

test('parseDatadogCsv keeps an outlier/out-of-window slot as its own isolated row, not merged into a nearby slot', () => {
  const csv = [
    'Date,Host,Service,Content',
    '2026-07-29T06:50:24.000Z,redacted-host,eth-staking,"INFO New block received slot: 3591700, root: 0x1111"',
    // an outlier far in the future relative to the main cluster above
    '2026-07-29T09:00:00.000Z,redacted-host,eth-staking,"INFO New block received slot: 3592350, root: 0x2222"',
  ].join('\n');

  const result = parseDatadogCsv(csv);
  assert.equal(result.rows.length, 2);
  const slots = result.rows.map(r => r.slot).sort((x, y) => x - y);
  assert.deepEqual(slots, [3591700, 3592350]);
});

test('parseDatadogCsv represents the complete set of distinct slots found in a larger CSV (no silent row loss)', () => {
  const lines = ['Date,Host,Service,Content'];
  const baseSlot = 3600000;
  for (let i = 0; i < 500; i++) {
    const slot = baseSlot + i;
    const ts = new Date(1742213400000 + slot * 12000).toISOString();
    lines.push(`${ts},redacted-host,eth-staking,"INFO New block received slot: ${slot}, root: 0xabc${i}"`);
  }
  const csv = lines.join('\n');

  const start = Date.now();
  const result = parseDatadogCsv(csv);
  const elapsedMs = Date.now() - start;

  assert.equal(result.stats.parsedEvents, 500);
  assert.equal(result.rows.length, 500);
  const slots = new Set(result.rows.map(r => r.slot));
  for (let i = 0; i < 500; i++) assert.ok(slots.has(baseSlot + i), `missing row for slot ${baseSlot + i}`);
  assert.ok(elapsedMs < 5000, `parsing 500 rows took too long: ${elapsedMs}ms`);
});

test('parseDatadogCsvFiles combines separate BN and VC exports into one slot window', () => {
  const bn = [
    'Date,Host,Service,Content',
    '2026-07-29T04:56:37.339Z,redacted-host,eth-staking,"INFO New block received slot: 3590633, root: 0x1234abcd"',
  ].join('\n');
  const vc = [
    'Date,Host,Service,Content',
    '2026-07-29T05:18:50.203Z,redacted-host,eth-staking-validator,"Failed to attest based on head event validators: [""12345""]"',
  ].join('\n');

  const result = parseDatadogCsvFiles([
    { name: 'bn.csv', text: bn },
    { name: 'vc.csv', text: vc },
  ]);

  assert.equal(result.stats.fileCount, 2);
  assert.deepEqual(result.stats.fileNames, ['bn.csv', 'vc.csv']);
  assert.equal(result.stats.totalRows, 2);
  assert.equal(result.stats.parsedEvents, 2);
  assert.equal(result.stats.minSlot, 3590633);
  assert.equal(result.stats.maxSlot, 3590744);
  assert.equal(result.stats.serviceCounts['eth-staking'], 1);
  assert.equal(result.stats.serviceCounts['eth-staking-validator'], 1);
  assert.equal(result.rows.length, 2);
});

test('enrichRowsWithChainData fills chain-only fields on an exact (slot, validator_index) match', () => {
  const csvRows = [{
    slot: 3591500,
    validator_index: 12345,
    validator_pubkey: '',
    block_on_chain: null,
    head_correct: null,
    inclusion_distance: null,
    propagation_delay_ms: null,
    aggregator_picked: null,
  }];
  const chainRows = [{
    slot: 3591500,
    validator_index: 12345,
    validator_pubkey: '0xabc',
    validator_name: 'val-12345',
    block_on_chain: 1,
    proposer_index: 44,
    exec_block_number: 3309408,
    head_correct: 1,
    target_correct: 1,
    source_correct: 1,
    inclusion_slot: 3591500,
    inclusion_distance: 0,
    committee_index: 5,
    propagation_delay_ms: 210,
    aggregator_picked: 0,
  }];

  const enriched = enrichRowsWithChainData(csvRows, chainRows);

  assert.equal(enriched.length, 1);
  const row = enriched[0];
  assert.equal(row.validator_name, 'val-12345');
  assert.equal(row.block_on_chain, 1);
  assert.equal(row.proposer_index, 44);
  assert.equal(row.exec_block_number, 3309408);
  assert.equal(row.head_correct, 1);
  assert.equal(row.inclusion_distance, 0);
  assert.equal(row.committee_index, 5);
  assert.equal(row.propagation_delay_ms, 210);
  assert.equal(row.chain_enriched, true);
});

test('enrichRowsWithChainData never enriches a CSV row with no validator identity, even if a chain row shares the exact slot (regression for the original ClickHouse-leak bug)', () => {
  const csvRows = [{
    slot: 3591600,
    validator_index: null,
    validator_pubkey: '',
    block_on_chain: null,
    head_correct: null,
  }];
  const chainRows = [{
    slot: 3591600,
    validator_index: 99999,
    validator_pubkey: '0xchain',
    validator_name: 'someone-elses-validator',
    block_on_chain: 1,
    head_correct: 1,
  }];

  const enriched = enrichRowsWithChainData(csvRows, chainRows);

  assert.equal(enriched.length, 1);
  const row = enriched[0];
  assert.equal(row.validator_name, undefined);
  assert.equal(row.block_on_chain, null);
  assert.equal(row.head_correct, null);
  assert.equal(row.chain_enriched, false);
});

test('enrichRowsWithChainData matches each validator in a shared slot to its own chain row, never cross-matching', () => {
  const csvRows = [
    { slot: 3591700, validator_index: 111, validator_pubkey: '', head_correct: null },
    { slot: 3591700, validator_index: 222, validator_pubkey: '', head_correct: null },
  ];
  const chainRows = [
    { slot: 3591700, validator_index: 111, validator_pubkey: '0x111', head_correct: 1, inclusion_distance: 1 },
    { slot: 3591700, validator_index: 222, validator_pubkey: '0x222', head_correct: 0, inclusion_distance: 3 },
  ];

  const enriched = enrichRowsWithChainData(csvRows, chainRows);

  const row111 = enriched.find(r => r.validator_index === 111);
  const row222 = enriched.find(r => r.validator_index === 222);
  assert.equal(row111.head_correct, 1);
  assert.equal(row111.inclusion_distance, 1);
  assert.equal(row222.head_correct, 0);
  assert.equal(row222.inclusion_distance, 3);
});

test('enrichRowsWithChainData never overwrites a value the CSV/logs already derived', () => {
  const csvRows = [{
    slot: 3591800,
    validator_index: 333,
    validator_pubkey: '',
    block_on_chain: true, // already derived from an HTTP 200 access-log line
    missed: null,
  }];
  const chainRows = [{
    slot: 3591800,
    validator_index: 333,
    validator_pubkey: '0x333',
    block_on_chain: 0, // chain disagrees / is stale — CSV's own observation must win
    missed: 1,
  }];

  const enriched = enrichRowsWithChainData(csvRows, chainRows);

  assert.equal(enriched[0].block_on_chain, true);
  assert.equal(enriched[0].missed, 1);
});

test('enrichRowsWithChainData leaves fields null when no chain row matches (renders as "-")', () => {
  const csvRows = [{
    slot: 3591900,
    validator_index: 444,
    validator_pubkey: '',
    head_correct: null,
    inclusion_distance: null,
  }];

  const enriched = enrichRowsWithChainData(csvRows, []);

  assert.equal(enriched[0].head_correct, null);
  assert.equal(enriched[0].inclusion_distance, null);
  assert.equal(enriched[0].chain_enriched, false);
});
