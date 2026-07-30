"""ATTMON charts dashboard — one real Plotly chart per table column.

Server-side rendered: every request re-queries ClickHouse and rebuilds every
figure in Python (figures.py), then serves plain HTML with Plotly.js pulled
from CDN once. The page meta-refreshes on an interval instead of polling via
JS — keeps this whole service dependency-free on the client side.
"""

import os

from fastapi import FastAPI, Query
from fastapi.responses import HTMLResponse

from columns import SECTIONS
from data import fetch_diagnostics
import figures

app = FastAPI()

PLOTLY_CDN = "https://cdn.plot.ly/plotly-2.32.0.min.js"

PAGE_CSS = """
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body {
  margin: 0; background: #0a0f1a; color: #e6ebf3;
  font-family: Inter, -apple-system, "Segoe UI", sans-serif;
}
header {
  padding: 14px 20px; border-bottom: 1px solid #23304a; background: #111827;
  display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap;
}
header h1 { font-size: 16px; margin: 0; }
header h1 span { color: #6b7688; font-weight: 400; }
header .meta { font-size: 12px; color: #a7b2c6; }
header a { color: #4c7fe0; text-decoration: none; font-size: 12px; }
.stat-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 8px; padding: 12px 20px 0; }
.stat-tile { border: 1px solid #23304a; border-radius: 6px; background: #131c2e; }
.section-title {
  margin: 18px 20px 4px; font-size: 11px; font-weight: 700; letter-spacing: .08em;
  text-transform: uppercase; color: #4c7fe0; border-bottom: 1px solid #23304a; padding-bottom: 4px;
}
.charts-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 8px; padding: 0 20px 8px;
}
.chart-cell { border: 1px solid #23304a; border-radius: 6px; background: #0d1420; overflow: hidden; }
footer { padding: 10px 20px 24px; color: #6b7688; font-size: 11px; }
"""


def ratio_tone(pct):
    if pct is None:
        return "dim"
    return "ok" if pct >= 98 else "warn" if pct >= 90 else "bad"


def build_page(epochs: int, refresh: int) -> str:
    df = fetch_diagnostics(epochs)
    n = len(df)

    def ratio(col):
        s = df[col].dropna() if n else df
        if s.empty:
            return None, 0, 0
        hit = int((s == 1).sum())
        return hit / len(s) * 100, hit, len(s)

    head_pct, head_hit, head_n = ratio("head_correct") if n else (None, 0, 0)
    target_pct, target_hit, target_n = ratio("target_correct") if n else (None, 0, 0)
    missed_n = int(df["missed"].dropna().eq(1).sum()) if n else 0
    missed_total = int(df["missed"].notna().sum()) if n else 0
    missed_tone = "dim" if not missed_total else ("ok" if missed_n == 0 else (
        "warn" if missed_n / missed_total <= 0.05 else "bad"))

    stat_figs = [
        figures.stat_tile("HEAD HIT RATIO", head_pct, "%", ratio_tone(head_pct)),
        figures.stat_tile("TARGET HIT RATIO", target_pct, "%", ratio_tone(target_pct)),
        figures.stat_tile("MISSED ATTESTATIONS", missed_n, "", missed_tone),
    ]

    parts = []
    idx = 0
    for fig in stat_figs:
        parts.append(f'<div class="stat-tile">{_div(fig, idx)}</div>')
        idx += 1
    stat_html = f'<div class="stat-row">{"".join(parts)}</div>'

    body = [stat_html]
    for section, cols in SECTIONS:
        cells = []
        for key, label, kind in cols:
            if kind == "bool":
                fig = figures.bool_strip(df, key, label)
            elif kind == "cat":
                fig = figures.cat_strip(df, key, label)
            elif kind == "ms":
                fig = figures.num_bars(df, key, label, ms=True)
            else:
                fig = figures.num_bars(df, key, label, ms=False)
            cells.append(f'<div class="chart-cell">{_div(fig, idx)}</div>')
            idx += 1
        body.append(f'<div class="section-title">{section}</div>')
        body.append(f'<div class="charts-grid">{"".join(cells)}</div>')

    sub = f"{n} rows loaded" if n else "no rows yet — indexer may still be backfilling"
    return f"""<!doctype html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="{refresh}">
<title>ATTMON — on-chain metric charts</title>
<script src="{PLOTLY_CDN}"></script>
<style>{PAGE_CSS}</style>
</head><body>
<header>
  <h1>ATTMON <span>// on-chain metric charts</span></h1>
  <span class="meta">{sub}</span>
  <span class="meta">epochs <b>{epochs}</b></span>
  <a href="/?epochs=25">25</a><a href="/?epochs=50">50</a><a href="/?epochs=100">100</a><a href="/?epochs=300">300</a>
  <span class="meta">refresh {refresh}s</span>
  <a href="http://localhost:8080">&larr; table view</a>
</header>
{"".join(body)}
<footer>full data: ClickHouse localhost:8123 attmon.attestation_diagnostics — one chart per table column, grouped to match the table's sections</footer>
</body></html>"""


def _div(fig, idx):
    return fig.to_html(
        full_html=False, include_plotlyjs=False, div_id=f"c{idx}",
        config={"displayModeBar": False, "responsive": True},
    )


@app.get("/", response_class=HTMLResponse)
def index(epochs: int = Query(50, ge=1, le=2000), refresh: int = Query(15, ge=5, le=300)):
    return build_page(epochs, refresh)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8090")))
