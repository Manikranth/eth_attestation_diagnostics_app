# Vertical Slot Bars Design

## Goal

Add a modern interactive visualization to the ATTMON web dashboard that turns the currently visible diagnostics table rows into a vertical stacked bar chart.

The chart answers: for every slot in the table, how much of the slot window was spent in each stage of the attestation process?

## Approved Shape

- X axis: slots from the current table result set.
- Y axis: time within the slot window, bottom to top.
- One vertical stacked bar per visible table row.
- Each colored segment represents one process stage.
- The existing diagnostics table remains intact below the chart.
- Filters, live refresh, pause, and Datadog CSV mode all drive the chart from the same `rows` data already passed to `renderRows(rows)`.

## Visual Design

The chart should feel like an operator-grade diagnostic tool, not a decorative report.

- Place the chart between the fault chips and the legend/table.
- Use the existing dark terminal theme, but make the chart cleaner and more modern with refined spacing, clear axis labels, stable dimensions, and readable tooltips.
- Keep colors distinct by meaning:
  - propagation / block arrival: green
  - blob wait: cyan or blue
  - consensus / EL verify: amber
  - import / set head: orange
  - validator-client publish: violet
  - missed or unusable timeline: red striped fill
- Show a compact legend directly in the chart header.
- Keep chart height fixed enough to compare bars reliably, around 260-340px on desktop.
- Support horizontal scrolling when many slots are visible.
- On small screens, preserve bar readability by keeping each slot bar a fixed minimum width and letting the chart scroll horizontally.

## Data Mapping

The chart uses fields already present in `attestation_diagnostics` rows. It should not add a new backend endpoint.

Segments:

- `propagation`: from slot start to first local block sighting, using `block_seen_ms` when available. If `propagation_delay_ms` is the only available propagation value, use it for attestation gossip timing but label it clearly.
- `blob_wait`: time from block sighting to data availability, using `avail_dur_ms` when available, otherwise derive from `available_ms - block_seen_ms` when both exist.
- `verify`: sum of `consensus_verify_ms` and `el_verify_ms` when present.
- `import`: sum of `import_write_ms` and `set_as_head_ms` when present. If these durations are missing but `imported_ms` exists, do not invent a duration.
- `vc_publish`: `vc_publish_dur_ms` when present.

Bar height:

- Use the sum of known segment durations for stacked height.
- Scale the normal Y axis to 12,000ms because an Ethereum slot is 12 seconds.
- If a bar exceeds 12,000ms, cap the visible bar at the chart top and show an overflow marker with the exact total in the tooltip.
- If all segment durations are missing but the row is missed or failed, show a full-height red striped state bar.
- If a row has partial data, render known segments and show a subtle missing-data indicator in the tooltip.

Ordering:

- Preserve the same row order as the table so the chart and table stay mentally aligned.
- If the current table is newest-first, the chart is newest-first left to right.

## Interaction

- Hovering a segment shows a tooltip with:
  - slot
  - validator index or name
  - stage name
  - duration
  - source fields used
  - total known process time
  - fault attribution
- Hovering a whole bar lightly highlights the matching table row.
- Clicking a bar selects the slot:
  - selected bar remains highlighted
  - matching table row gets a persistent selected style
  - if the row is outside the current scroll viewport, the table scrolls to it
- Clicking the selected bar again clears selection.
- Live refresh preserves selection when the selected `slot:validator_index` key still exists.
- Add a small control group:
  - `fit 12s`: default scale
  - `fit data`: scale to the largest visible bar
  - `compact`: toggles smaller bar width for large result sets

## Component Boundary

Keep the implementation local to `web/index.html` unless the file becomes too large to work safely.

Suggested frontend units:

- `stageSegments(row)`: converts one diagnostics row into normalized chart segments.
- `renderSlotChart(rows)`: renders chart markup and summary stats.
- `bindSlotChartInteractions()`: attaches hover, click, and scroll/highlight behavior.
- `rowKey(row)`: returns stable `slot:validator_index`.

`renderRows(rows)` should call `renderSlotChart(rows)` so every data source updates both views together.

## Empty And Error States

- No rows: chart shows the same no-data state as the table, with no stale bars.
- Fetch error: leave the last successful chart visible only if the table also does; otherwise clear both together.
- CSV-only rows with limited timing data: render partial bars and label missing fields in tooltips.

## Testing

Manual verification is required because this is a browser visualization.

- Start the local web server.
- Verify live diagnostics render chart and table from the same rows.
- Apply epoch, slot, and field filters; chart updates with table.
- Switch to Datadog CSV mode; chart updates with CSV-enriched rows.
- Hover segments and confirm tooltip values match table fields.
- Click bars and confirm matching rows highlight and scroll into view.
- Resize to mobile width and confirm chart scrolls horizontally without overlapping controls.

Automated test coverage should focus on deterministic data mapping if the repo has a practical JavaScript test path:

- `stageSegments(row)` handles full data, partial data, missed slots, and overflow.
- `rowKey(row)` is stable.

## Out Of Scope

- New ClickHouse queries or backend APIs.
- Replacing the diagnostics table.
- Per-peer sentry visualizations for deferred fields.
- Drag-to-select slot ranges in the first implementation.
