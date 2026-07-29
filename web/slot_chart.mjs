export const SLOT_WINDOW_MS = 12000;

export const STAGE_META = {
  propagation: {
    label: 'Block arrival',
    colorClass: 'stage-propagation',
    sourceLabel: 'block_seen_ms / propagation_delay_ms',
  },
  blob_wait: {
    label: 'Blob wait',
    colorClass: 'stage-blob',
    sourceLabel: 'avail_dur_ms / available_ms - block_seen_ms',
  },
  verify: {
    label: 'Verify',
    colorClass: 'stage-verify',
    sourceLabel: 'consensus_verify_ms + el_verify_ms',
  },
  import: {
    label: 'Import / head',
    colorClass: 'stage-import',
    sourceLabel: 'import_write_ms + set_as_head_ms',
  },
  vc_publish: {
    label: 'VC publish',
    colorClass: 'stage-vc',
    sourceLabel: 'vc_publish_dur_ms',
  },
  missed: {
    label: 'Missed / no timeline',
    colorClass: 'stage-missed',
    sourceLabel: 'missed / fault_attribution',
  },
};

const hasNumber = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const positive = value => hasNumber(value) && Number(value) > 0;
const toMs = value => Number(value);

function segment(id, ms, source) {
  return {
    id,
    ms,
    source,
    label: STAGE_META[id].label,
    colorClass: STAGE_META[id].colorClass,
  };
}

export function rowKey(row) {
  return `${row.slot}:${row.validator_index ?? row.validator_pubkey ?? ''}`;
}

export function stageSegments(row) {
  const segments = [];
  const missing = [];

  if (positive(row.block_seen_ms)) {
    segments.push(segment('propagation', toMs(row.block_seen_ms), 'block_seen_ms'));
  } else if (positive(row.propagation_delay_ms)) {
    segments.push(segment('propagation', toMs(row.propagation_delay_ms), 'propagation_delay_ms'));
  } else {
    missing.push('propagation');
  }

  if (positive(row.avail_dur_ms)) {
    segments.push(segment('blob_wait', toMs(row.avail_dur_ms), 'avail_dur_ms'));
  } else if (positive(row.available_ms) && positive(row.block_seen_ms) && Number(row.available_ms) > Number(row.block_seen_ms)) {
    segments.push(segment('blob_wait', Number(row.available_ms) - Number(row.block_seen_ms), 'available_ms - block_seen_ms'));
  } else {
    missing.push('blob_wait');
  }

  const verifyMs = (positive(row.consensus_verify_ms) ? toMs(row.consensus_verify_ms) : 0)
    + (positive(row.el_verify_ms) ? toMs(row.el_verify_ms) : 0);
  if (verifyMs > 0) {
    segments.push(segment('verify', verifyMs, 'consensus_verify_ms + el_verify_ms'));
  } else {
    missing.push('verify');
  }

  const importMs = (positive(row.import_write_ms) ? toMs(row.import_write_ms) : 0)
    + (positive(row.set_as_head_ms) ? toMs(row.set_as_head_ms) : 0);
  if (importMs > 0) {
    segments.push(segment('import', importMs, 'import_write_ms + set_as_head_ms'));
  } else {
    missing.push('import');
  }

  if (positive(row.vc_publish_dur_ms)) {
    segments.push(segment('vc_publish', toMs(row.vc_publish_dur_ms), 'vc_publish_dur_ms'));
  } else {
    missing.push('vc_publish');
  }

  let isStateOnly = false;
  if (segments.length === 0 && (Number(row.missed) === 1 || (row.fault_attribution && row.fault_attribution !== 'perfect'))) {
    segments.push(segment('missed', SLOT_WINDOW_MS, 'missed / fault_attribution'));
    isStateOnly = true;
  }

  const totalMs = segments.reduce((sum, item) => sum + item.ms, 0);
  return {
    key: rowKey(row),
    row,
    segments,
    missing,
    totalMs,
    overflow: totalMs > SLOT_WINDOW_MS,
    hasPartialData: segments.length > 0 && missing.length > 0,
    isStateOnly,
  };
}

export function chartScaleMax(rows, scaleMode) {
  if (scaleMode !== 'data') return SLOT_WINDOW_MS;
  const max = rows.reduce((value, row) => Math.max(value, stageSegments(row).totalMs), SLOT_WINDOW_MS);
  return Math.max(SLOT_WINDOW_MS, max);
}
