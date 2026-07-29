import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCsv,
  detectDatadogMapping,
  parseDatadogCsv,
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
