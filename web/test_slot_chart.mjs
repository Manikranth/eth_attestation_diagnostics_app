import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SLOT_WINDOW_MS,
  rowKey,
  stageSegments,
  chartScaleMax,
} from './slot_chart.mjs';

test('rowKey combines slot and validator index', () => {
  assert.equal(rowKey({ slot: 123, validator_index: 456 }), '123:456');
});

test('rowKey falls back to validator pubkey when index is absent', () => {
  assert.equal(rowKey({ slot: 123, validator_index: null, validator_pubkey: '0xabc' }), '123:0xabc');
});

test('stageSegments maps full timing data into colored process stages', () => {
  const result = stageSegments({
    slot: 123,
    validator_index: 456,
    block_seen_ms: 3600,
    avail_dur_ms: 800,
    consensus_verify_ms: 120,
    el_verify_ms: 280,
    import_write_ms: 90,
    set_as_head_ms: 60,
    vc_publish_dur_ms: 500,
    fault_attribution: 'perfect',
  });

  assert.equal(result.key, '123:456');
  assert.equal(result.totalMs, 5450);
  assert.equal(result.hasPartialData, false);
  assert.equal(result.isStateOnly, false);
  assert.deepEqual(result.segments.map(s => [s.id, s.ms]), [
    ['propagation', 3600],
    ['blob_wait', 800],
    ['verify', 400],
    ['import', 150],
    ['vc_publish', 500],
  ]);
});

test('stageSegments derives blob wait from available and block seen offsets', () => {
  const result = stageSegments({
    slot: 123,
    validator_index: 456,
    block_seen_ms: 2500,
    available_ms: 4200,
  });

  assert.deepEqual(result.segments.map(s => [s.id, s.ms]), [
    ['propagation', 2500],
    ['blob_wait', 1700],
  ]);
});

test('stageSegments uses propagation_delay_ms when block_seen_ms is absent', () => {
  const result = stageSegments({
    slot: 123,
    validator_index: 456,
    propagation_delay_ms: 1800,
  });

  assert.equal(result.segments[0].id, 'propagation');
  assert.equal(result.segments[0].ms, 1800);
  assert.equal(result.segments[0].source, 'propagation_delay_ms');
});

test('stageSegments creates red state-only segment for missed rows without timing', () => {
  const result = stageSegments({
    slot: 123,
    validator_index: 456,
    missed: 1,
    fault_attribution: 'node_broadcast_issue',
  });

  assert.equal(result.isStateOnly, true);
  assert.equal(result.totalMs, SLOT_WINDOW_MS);
  assert.deepEqual(result.segments.map(s => [s.id, s.ms]), [['missed', SLOT_WINDOW_MS]]);
});

test('stageSegments marks overflow when known duration exceeds the slot window', () => {
  const result = stageSegments({
    slot: 123,
    validator_index: 456,
    block_seen_ms: 9000,
    avail_dur_ms: 3000,
    vc_publish_dur_ms: 2000,
  });

  assert.equal(result.totalMs, 14000);
  assert.equal(result.overflow, true);
});

test('chartScaleMax returns 12s by default and data max when requested', () => {
  const rows = [
    { slot: 1, validator_index: 1, block_seen_ms: 2000 },
    { slot: 2, validator_index: 1, block_seen_ms: 16000 },
  ];

  assert.equal(chartScaleMax(rows, 'slot'), SLOT_WINDOW_MS);
  assert.equal(chartScaleMax(rows, 'data'), 16000);
});
