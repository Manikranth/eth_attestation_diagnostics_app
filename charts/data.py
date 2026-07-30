"""ClickHouse query helper — same HTTP JSON interface web/server.py uses."""

import os

import pandas as pd
import requests

from columns import ALL_COLUMNS, SELECT_FIELDS

_CAT_COLS = {c[0] for c in ALL_COLUMNS if c[2] == "cat"}

CLICKHOUSE_URL = os.environ.get("CLICKHOUSE_URL", "http://clickhouse:8123")
CH_USER = os.environ.get("CLICKHOUSE_USER", "attmon")
CH_PASSWORD = os.environ.get("CLICKHOUSE_PASSWORD", "attmon")


def fetch_diagnostics(epochs: int) -> pd.DataFrame:
    fields = ", ".join(SELECT_FIELDS)
    sql = (
        f"SELECT {fields} FROM attmon.attestation_diagnostics "
        f"WHERE epoch > (SELECT max(epoch) FROM attmon.chain_attestations) - {epochs} "
        "ORDER BY slot, validator_index FORMAT JSONCompact"
    )
    resp = requests.post(
        CLICKHOUSE_URL,
        data=sql.encode(),
        auth=(CH_USER, CH_PASSWORD),
        params={"max_execution_time": 20, "cancel_http_readonly_queries_on_client_close": 1},
        timeout=25,
    )
    resp.raise_for_status()
    payload = resp.json()
    cols = [m["name"] for m in payload["meta"]]
    df = pd.DataFrame(payload["data"], columns=cols)
    if not df.empty:
        df["slot_start_utc"] = pd.to_datetime(df["slot_start_utc"], utc=True)
        # ClickHouse's JSON/JSONCompact output stringifies UInt64/Int64 to
        # avoid JS precision loss — coerce every non-categorical column back
        # to numeric so downstream min/max/format code sees real numbers.
        for c in df.columns:
            if c in _CAT_COLS or c == "slot_start_utc":
                continue
            df[c] = pd.to_numeric(df[c], errors="coerce")
    return df
