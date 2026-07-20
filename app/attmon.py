"""Attestation Monitor CLI: renders the joined diagnostic view as a
color-coded terminal table, or exports it as JSON."""

import argparse
import json
import os
import sys
import time

import requests
from rich.console import Console
from rich.table import Table

CLICKHOUSE_URL = os.environ.get("CLICKHOUSE_URL", "http://localhost:8123")
CH_USER = os.environ.get("CLICKHOUSE_USER", "attmon")
CH_PASSWORD = os.environ.get("CLICKHOUSE_PASSWORD", "attmon")

FAULT_STYLES = {
    "perfect": "bold green",
    "included_late": "yellow",
    "partial_success": "yellow",
    "aggregator_missed": "magenta",
    "propagation_too_slow": "red",
    "wrong_head_vote": "red",
    "node_broadcast_issue": "bold red",
    "block_arrived_late": "bold red",
    "unknown": "dim",
}


def query_rows(where):
    sql = f"""
        SELECT * FROM attmon.attestation_diagnostics
        WHERE {where}
        ORDER BY slot, validator_index
        FORMAT JSON
    """
    r = requests.post(
        CLICKHOUSE_URL,
        params={"query": sql},
        auth=(CH_USER, CH_PASSWORD),
        timeout=60,
    )
    if not r.ok:
        sys.exit(f"ClickHouse error: {r.status_code} {r.text[:500]}")
    return r.json()["data"]


def fmt_bool(v):
    if v is None:
        return "[dim]-[/dim]"
    return "[green]✓[/green]" if int(v) else "[red]✗[/red]"


def fmt_ms(v):
    if v is None:
        return "[dim]-[/dim]"
    v = float(v)
    style = "green" if v <= 4000 else "red"
    return f"[{style}]{v:.0f}[/{style}]"


def fmt_root(v):
    return f"{v[:10]}…" if v else "-"


def render(rows, console, wide=False):
    table = Table(title="Attestation Diagnostics", expand=False)
    cols = [
        ("epoch", "Epoch"),
        ("slot", "Slot"),
        ("slot_start_utc", "Slot start (UTC)"),
        ("validator_index", "Validator"),
        ("validator_name", "Name"),
        ("committee_index", "Cmte"),
        ("committee_position", "Pos"),
        ("head_correct", "Head"),
        ("target_correct", "Tgt"),
        ("source_correct", "Src"),
        ("inclusion_slot", "Incl slot"),
        ("inclusion_distance", "Dist"),
        ("included_in_aggregate", "In agg"),
        ("missed", "Missed"),
        ("block_seen_ms", "Seen ms"),
        ("attestable_ms", "Attestable ms"),
        ("fault_attribution", "Fault"),
    ]
    if wide:
        cols[9:9] = [
            ("attested_head_root", "Att head"),
            ("attested_target_root", "Att target"),
            ("attested_source_root", "Att source"),
            ("canonical_head_root", "Canon head"),
        ]
        cols[-1:-1] = [
            ("stage_import_ms", "Import ms"),
            ("el_verify_ms", "EL vrfy ms"),
            ("propagation_delay_ms", "Propag ms"),
            ("subnet_id", "Subnet"),
            ("aggregator_picked", "Agg pick"),
        ]
    for key, header in cols:
        table.add_column(header, justify="right", no_wrap=(key == "fault_attribution"))

    for row in rows:
        cells = []
        for key, _ in cols:
            v = row.get(key)
            if key in ("head_correct", "target_correct", "source_correct",
                       "included_in_aggregate", "aggregator_picked"):
                cells.append(fmt_bool(v))
            elif key == "missed":
                cells.append("[bold red]YES[/bold red]" if int(v) else "[green]no[/green]")
            elif key.endswith("_ms"):
                cells.append(fmt_ms(v))
            elif key.endswith("_root"):
                cells.append(fmt_root(v))
            elif key == "fault_attribution":
                style = FAULT_STYLES.get(v, "white")
                cells.append(f"[{style}]{v}[/{style}]")
            elif key == "validator_name":
                cells.append(str(v)[:18] if v else "-")
            elif key == "inclusion_distance" and v is not None:
                style = "green" if int(v) == 1 else "yellow"
                cells.append(f"[{style}]{v}[/{style}]")
            else:
                cells.append("-" if v is None else str(v))
        table.add_row(*cells)

    console.print(table)
    if not rows:
        console.print("[dim]No rows. Indexer may still be backfilling.[/dim]")


def main():
    p = argparse.ArgumentParser(description="Attestation diagnostics viewer")
    p.add_argument("--last", type=int, default=5, metavar="N",
                   help="show last N indexed epochs (default 5)")
    p.add_argument("--from-epoch", type=int, help="start epoch (inclusive)")
    p.add_argument("--to-epoch", type=int, help="end epoch (inclusive)")
    p.add_argument("--live", action="store_true",
                   help="poll and re-render every 30s")
    p.add_argument("--json", metavar="FILE",
                   help="write full rows as JSON to FILE ('-' for stdout)")
    p.add_argument("--wide", action="store_true", help="show all 25 columns")
    args = p.parse_args()

    if args.from_epoch is not None:
        to = args.to_epoch if args.to_epoch is not None else args.from_epoch
        where = f"epoch BETWEEN {args.from_epoch} AND {to}"
    else:
        where = (
            "epoch > (SELECT max(epoch) FROM attmon.attestation_diagnostics)"
            f" - {args.last}"
        )

    console = Console()
    while True:
        rows = query_rows(where)
        if args.json:
            out = json.dumps(rows, indent=2)
            if args.json == "-":
                print(out)
            else:
                with open(args.json, "w") as f:
                    f.write(out)
                console.print(f"[green]Wrote {len(rows)} rows to {args.json}[/green]")
        else:
            if args.live:
                console.clear()
            render(rows, console, wide=args.wide)
        if not args.live:
            break
        time.sleep(30)


if __name__ == "__main__":
    main()
