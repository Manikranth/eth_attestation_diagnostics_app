import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCsv,
  detectDatadogMapping,
  mergeDiagnosticsRows,
  parseDatadogCsv,
  parseDatadogCsvFiles,
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

test('mergeDiagnosticsRows keeps ClickHouse facts and fills blanks from CSV logs', () => {
  const clickhouseRows = [{
    slot: '3590633',
    validator_index: 12345,
    validator_pubkey: '0xabc',
    inclusion_distance: 1,
    fault_attribution: 'perfect',
    block_seen_ms: null,
    peers: null,
  }];
  const csvRows = [{
    slot: 3590633,
    validator_index: 12345,
    validator_pubkey: '',
    inclusion_distance: null,
    fault_attribution: 'log_preview',
    block_seen_ms: 1339,
    peers: 200,
  }];

  const merged = mergeDiagnosticsRows(clickhouseRows, csvRows);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].validator_index, 12345);
  assert.equal(merged[0].inclusion_distance, 1);
  assert.equal(merged[0].fault_attribution, 'perfect');
  assert.equal(merged[0].block_seen_ms, 1339);
  assert.equal(merged[0].peers, 200);
});

test('mergeDiagnosticsRows does not render ClickHouse-only rows when CSV identity differs', () => {
  const clickhouseRows = [{
    slot: 3590633,
    validator_index: 99999,
    validator_pubkey: '0xchain',
    inclusion_distance: 1,
    fault_attribution: 'perfect',
  }];
  const csvRows = [{
    slot: 3590633,
    validator_index: 12345,
    validator_pubkey: '',
    att_failures: 1,
    fault_attribution: 'vc_head_event_failed',
  }];

  const merged = mergeDiagnosticsRows(clickhouseRows, csvRows);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].validator_index, 12345);
  assert.equal(merged[0].fault_attribution, 'vc_head_event_failed');
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
