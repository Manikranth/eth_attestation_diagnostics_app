# Vertical Slot Bars Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a modern interactive vertical stacked bar chart for every currently visible diagnostics table slot.

**Architecture:** Add a small JavaScript data-mapping module for deterministic timing calculations, then integrate a chart section into `web/index.html` that renders from the same `rows` passed to the table. Interactions use stable `slot:validator_index` row keys to highlight and select matching chart bars and table rows.

**Tech Stack:** Browser ES modules, plain HTML/CSS/JavaScript, Node test runner for deterministic JS tests, existing stdlib Python web server.

---

### Task 1: Add Testable Slot Chart Data Mapping

**Files:**
- Create: `web/slot_chart.mjs`
- Create: `web/test_slot_chart.mjs`

- [ ] **Step 1: Write the failing tests**

Create `web/test_slot_chart.mjs`:

```javascript
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test web/test_slot_chart.mjs`

Expected: FAIL with `Cannot find module` for `web/slot_chart.mjs`.

- [ ] **Step 3: Implement the data mapping module**

Create `web/slot_chart.mjs`:

```javascript
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
const toMs = value => Number(value);

const positive = value => hasNumber(value) && Number(value) > 0;

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
  return `${row.slot}:${row.validator_index}`;
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
  if (segments.length === 0 && (Number(row.missed) === 1 || row.fault_attribution && row.fault_attribution !== 'perfect')) {
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test web/test_slot_chart.mjs`

Expected: PASS for all seven tests.

### Task 2: Add The Chart Shell And Styling

**Files:**
- Modify: `web/index.html`

- [ ] **Step 1: Add the module import**

Change the existing import at the top of the module script to:

```javascript
import { parseCsv, detectDatadogMapping, mergeDiagnosticsRows, parseDatadogCsv } from './datadog_csv.mjs';
import { SLOT_WINDOW_MS, STAGE_META, chartScaleMax, rowKey, stageSegments } from './slot_chart.mjs';
```

- [ ] **Step 2: Add chart state near the existing top-level state**

Add:

```javascript
let chartScaleMode = 'slot', chartCompact = false, selectedSlotKey = null, hoveredSlotKey = null;
```

- [ ] **Step 3: Add chart markup between chips and legend**

Insert after `<div class="chips" id="chips"></div>`:

```html
<section class="slotviz" id="slotViz" aria-label="slot process timeline">
  <div class="slotviz-head">
    <div>
      <h2>slot process bars</h2>
      <p id="slotVizSummary">waiting for rows</p>
    </div>
    <div class="slotviz-legend" id="slotVizLegend"></div>
    <div class="slotviz-controls" aria-label="chart controls">
      <button class="chartMode active" data-scale="slot" id="chartFitSlot">fit 12s</button>
      <button class="chartMode" data-scale="data" id="chartFitData">fit data</button>
      <button id="chartCompact">compact</button>
    </div>
  </div>
  <div class="slotviz-body">
    <div class="slotviz-axis" id="slotVizAxis"></div>
    <div class="slotviz-scroll" id="slotVizScroll">
      <div class="slotviz-plot" id="slotVizPlot"></div>
    </div>
  </div>
  <div class="slotviz-tooltip" id="slotVizTooltip" hidden></div>
</section>
```

- [ ] **Step 4: Add CSS for the chart**

Add CSS near the existing `.chips` and `.legend` styles for `.slotviz`, `.slotbar`, stage colors, selected and hover states, tooltip, and responsive horizontal scrolling.

- [ ] **Step 5: Verify page still loads**

Run: `python3 -m py_compile web/server.py`

Expected: PASS with no output.

### Task 3: Render Bars From The Same Rows As The Table

**Files:**
- Modify: `web/index.html`

- [ ] **Step 1: Add formatting helpers**

Add:

```javascript
const fmtMs = ms => fmtT(Number(ms) / 1000);
const pct = (value, max) => Math.max(0, Math.min(100, (Number(value) / max) * 100));
```

- [ ] **Step 2: Add chart render functions**

Add `renderSlotChart(rows)`, `renderSlotVizAxis(maxMs)`, `renderSlotVizLegend()`, and `slotTooltipHtml(item, segment)` inside the script. `renderSlotChart(rows)` must use `rows.map(stageSegments)` and preserve row order.

- [ ] **Step 3: Call chart render from table render**

At the start of `renderRows(rows)`, call:

```javascript
renderSlotChart(rows);
```

- [ ] **Step 4: Add stable table row keys**

Change each table `<tr>` to include:

```javascript
`<tr data-row-key="${esc(rowKey(r))}"${fresh ? ' class="fresh"' : ''}>`
```

If the row is selected or hovered, include `slot-selected` or `slot-hovered` classes.

- [ ] **Step 5: Verify deterministic mapping tests still pass**

Run: `node --test web/test_slot_chart.mjs`

Expected: PASS.

### Task 4: Add Hover, Selection, And Controls

**Files:**
- Modify: `web/index.html`

- [ ] **Step 1: Add row highlight helpers**

Add `syncSlotSelection()`, `clearSlotHover()`, and `selectSlotKey(key, scroll)` helpers. These update chart bars and table rows without re-fetching data.

- [ ] **Step 2: Bind chart interactions**

After rendering chart bars, bind:

```javascript
bar.onmouseenter = () => { hoveredSlotKey = key; syncSlotSelection(); };
bar.onmouseleave = () => { hoveredSlotKey = null; syncSlotSelection(); };
bar.onclick = () => selectSlotKey(selectedSlotKey === key ? null : key, true);
segment.onmouseenter = event => showSlotTooltip(event, item, segmentData);
segment.onmousemove = moveSlotTooltip;
segment.onmouseleave = hideSlotTooltip;
```

- [ ] **Step 3: Bind scale and compact controls**

Wire `#chartFitSlot`, `#chartFitData`, and `#chartCompact` so they update `chartScaleMode` / `chartCompact` and rerender the current `liveRows` or `csvRows`.

- [ ] **Step 4: Preserve selection across refresh**

After `renderRows(rows)`, if `selectedSlotKey` is no longer present in the new row keys, clear it.

- [ ] **Step 5: Verify interactions manually**

Start the web server, open the dashboard, hover/click bars, and verify table row highlighting.

### Task 5: Final Verification

**Files:**
- Modify: `web/index.html`
- Create: `web/slot_chart.mjs`
- Create: `web/test_slot_chart.mjs`

- [ ] **Step 1: Run JavaScript tests**

Run: `node --test web/test_slot_chart.mjs web/test_datadog_csv.mjs`

Expected: PASS.

- [ ] **Step 2: Run Python tests**

Run: `python3 -m pytest web/test_server.py`

Expected: PASS.

- [ ] **Step 3: Inspect changed files**

Run: `git diff -- web/index.html web/slot_chart.mjs web/test_slot_chart.mjs`

Expected: diff shows only the vertical slot bar chart, data mapping module, and tests.
