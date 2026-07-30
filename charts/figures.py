"""Plotly figure builders — one function per column `kind`. Dark theme, no
plotly.js re-download per figure (the page includes it once via CDN and every
figure below is rendered with include_plotlyjs=False).
"""

import plotly.graph_objects as go

BG = "#0d1420"
GRID = "#23304a"
TEXT = "#a7b2c6"
OK = "#34d399"
BAD = "#f2596b"
DIM = "#4b5568"
ACCENT = "#4c7fe0"
WARN = "#f2ab3d"

CAT_PALETTE = [
    "#4c7fe0", "#34d399", "#f2ab3d", "#f2596b", "#4fc3e0",
    "#9085e9", "#d55181", "#c98500", "#199e70", "#8994a8",
]

LAYOUT_BASE = dict(
    template="plotly_dark",
    paper_bgcolor=BG,
    plot_bgcolor=BG,
    font=dict(color=TEXT, size=10, family="IBM Plex Mono, ui-monospace, monospace"),
    margin=dict(l=40, r=8, t=40, b=22),
    height=180,
    showlegend=False,
)


def _title(main, sub=None):
    if sub:
        return dict(text=f"{main}<br><span style='font-size:9px;color:#6b7688'>{sub}</span>",
                     font=dict(size=11), x=0.03, xanchor="left")
    return dict(text=main, font=dict(size=11), x=0.03, xanchor="left")


def _empty(title):
    fig = go.Figure()
    fig.update_layout(**LAYOUT_BASE, title=_title(title))
    fig.add_annotation(text="no data yet", showarrow=False, font=dict(color=DIM, size=11))
    fig.update_xaxes(visible=False)
    fig.update_yaxes(visible=False)
    return fig


def _axes(fig):
    fig.update_xaxes(gridcolor=GRID, showline=False, tickfont=dict(size=8))
    fig.update_yaxes(gridcolor=GRID, showline=False, tickfont=dict(size=8), zeroline=False)
    return fig


def bool_strip(df, col, title):
    """0/1/null status strip: green=yes, red=no, gray=unknown."""
    sub = df[["slot_start_utc", col]].copy()
    if sub.empty:
        return _empty(title)
    colors, labels = [], []
    for v in sub[col]:
        if v is None or (isinstance(v, float) and v != v):
            colors.append(DIM); labels.append("unknown")
        elif float(v) == 1:
            colors.append(OK); labels.append("yes")
        else:
            colors.append(BAD); labels.append("no")
    n = len(sub)
    hit = sum(1 for c in colors if c == OK)
    miss = sum(1 for c in colors if c == BAD)
    fig = go.Figure(go.Bar(
        x=sub["slot_start_utc"], y=[1] * n,
        marker_color=colors, text=labels, hoverinfo="x+text",
        width=1000 * 11,
    ))
    fig.update_layout(**LAYOUT_BASE, title=_title(title, f"{hit} hit / {miss} miss / {n - hit - miss} unk"))
    fig.update_yaxes(visible=False)
    fig.update_xaxes(gridcolor=GRID, tickfont=dict(size=8))
    return fig


def cat_strip(df, col, title):
    """Categorical colored status strip — one color per distinct string."""
    sub = df[["slot_start_utc", col]].copy()
    if sub.empty:
        return _empty(title)
    vals = sub[col].fillna("–").astype(str)
    uniq = list(dict.fromkeys(vals))
    palette = {v: CAT_PALETTE[i % len(CAT_PALETTE)] for i, v in enumerate(uniq)}
    if "–" in palette:
        palette["–"] = DIM
    colors = [palette[v] for v in vals]
    legend = "  ".join(f"<span style='color:{palette[v]}'>■</span>{v[:14]}" for v in uniq[:5])
    fig = go.Figure(go.Bar(
        x=sub["slot_start_utc"], y=[1] * len(sub),
        marker_color=colors, text=vals, hoverinfo="x+text",
        width=1000 * 11,
    ))
    fig.update_layout(**LAYOUT_BASE, title=_title(title, legend))
    fig.update_yaxes(visible=False)
    fig.update_xaxes(gridcolor=GRID, tickfont=dict(size=8))
    return fig


def num_bars(df, col, title, ms=False):
    """Line+marker trace — works for both small durations and large slowly-
    varying IDs (block numbers etc.) since the y-axis auto-scales to the data
    range instead of forcing a zero baseline like a bar chart would."""
    sub = df[["slot_start_utc", col]].dropna()
    if sub.empty:
        return _empty(title)
    lo, hi = sub[col].min(), sub[col].max()
    sub_text = f"min {lo:g} · max {hi:g}"
    fig = go.Figure(go.Scatter(
        x=sub["slot_start_utc"], y=sub[col],
        mode="lines+markers", line=dict(color=ACCENT, width=1.5),
        marker=dict(size=3, color=ACCENT),
    ))
    if ms:
        fig.add_hline(y=4000, line_dash="dash", line_color=WARN, line_width=1)
        fig.add_hline(y=8000, line_dash="dash", line_color=BAD, line_width=1)
    fig.update_layout(**LAYOUT_BASE, title=_title(title, sub_text))
    _axes(fig)
    return fig


def stat_tile(label, value, suffix, tone):
    """Big-number tile. `tone` is precomputed by the caller (ok/warn/bad/dim) —
    this function only renders, it doesn't decide thresholds."""
    color = {"ok": OK, "warn": WARN, "bad": BAD, "dim": DIM}.get(tone, DIM)
    fig = go.Figure(go.Indicator(
        mode="number",
        value=0 if value is None else value,
        number=dict(suffix=suffix, font=dict(size=34, color=color if value is not None else DIM),
                     valueformat=".1f" if suffix == "%" else "d"),
        title=dict(text=label, font=dict(size=12, color=TEXT)),
    ))
    fig.update_layout(
        template="plotly_dark", paper_bgcolor=BG, plot_bgcolor=BG,
        font=dict(color=TEXT, family="IBM Plex Mono, ui-monospace, monospace"),
        margin=dict(l=10, r=10, t=40, b=10), height=120,
    )
    return fig
