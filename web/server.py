"""Tiny web UI for the attestation monitor.

Serves a single-page dashboard and a JSON API that proxies the ClickHouse
joined view. Stdlib only — no dependencies.
"""

import base64
import json
import os
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, urlencode

CLICKHOUSE_URL = os.environ.get("CLICKHOUSE_URL", "http://clickhouse:8123")
CH_USER = os.environ.get("CLICKHOUSE_USER", "attmon")
CH_PASSWORD = os.environ.get("CLICKHOUSE_PASSWORD", "attmon")
PORT = int(os.environ.get("PORT", "8080"))

HERE = os.path.dirname(os.path.abspath(__file__))


# Server-side guard rails. Without these a slow query outlives the HTTP
# request that asked for it: urlopen's timeout only drops our socket, while
# ClickHouse happily keeps executing. The dashboard polls every 12s, so any
# query slower than that used to pile up unbounded until the box died.
CH_SETTINGS = {
    "max_execution_time": 20,                          # hard stop, server side
    "cancel_http_readonly_queries_on_client_close": 1,  # abandon = cancel
}


def ch_query(sql):
    url = CLICKHOUSE_URL + "?" + urlencode(CH_SETTINGS)
    req = urllib.request.Request(url, data=sql.encode(), method="POST")
    token = base64.b64encode(f"{CH_USER}:{CH_PASSWORD}".encode()).decode()
    req.add_header("Authorization", f"Basic {token}")
    # slightly longer than max_execution_time so ClickHouse's own timeout wins
    # and reports a real error instead of us abandoning the connection
    with urllib.request.urlopen(req, timeout=25) as resp:
        return json.loads(resp.read())


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/diagnostics":
            qs = parse_qs(parsed.query)
            epochs = int(qs.get("epochs", ["10"])[0])
            epochs = max(1, min(epochs, 500))
            try:
                # Take max(epoch) from the raw table, NOT the view: the view is
                # a multi-way join over an aggregation of every log event, so
                # using it here materialised the whole thing twice per request.
                data = ch_query(
                    "SELECT * FROM attmon.attestation_diagnostics "
                    "WHERE epoch > (SELECT max(epoch) FROM attmon.chain_attestations)"
                    f" - {epochs} "
                    "ORDER BY slot DESC, validator_index FORMAT JSON"
                )
                body = json.dumps({"rows": data["data"]}).encode()
                self._send(200, body, "application/json")
            except Exception as e:
                self._send(502, json.dumps({"error": str(e)}).encode(), "application/json")
        elif parsed.path.startswith("/api/slot/"):
            try:
                slot = int(parsed.path.rsplit("/", 1)[1])
            except ValueError:
                self._send(400, b'{"error":"bad slot"}', "application/json")
                return
            genesis = 1742213400
            start = genesis + slot * 12
            try:
                timeline = ch_query(
                    f"SELECT * FROM attmon.slot_timeline WHERE slot = {slot} FORMAT JSON"
                )
                # every raw event tied to this slot: by slot field, by block
                # root, or (for slot/root-less lines) by timestamp window
                events = ch_query(
                    "SELECT ts, src, event, slot, block_root, proposer_index,"
                    " validator_pubkey, validator_name,"
                    " peers, head_slot, current_slot, sync_state, delay_s,"
                    " observed_delay_ms, blob_delay_ms, consensus_time_ms,"
                    " execution_time_ms, available_delay_ms, attestable_delay_ms,"
                    " imported_time_ms, set_as_head_time_ms, total_delay_ms,"
                    " num_expected, num_fetched, count, committee_index, detail,"
                    f" round(toUnixTimestamp64Milli(ts)/1000 - {start}, 3) AS offset_s"
                    " FROM attmon.node_events"
                    f" WHERE slot = {slot}"
                    "  OR (block_root != '' AND block_root IN"
                    f"      (SELECT block_root FROM attmon.node_events WHERE slot = {slot} AND block_root != ''))"
                    "  OR (slot IS NULL AND block_root = ''"
                    f"      AND ts >= toDateTime64({start}, 3) AND ts < toDateTime64({start + 12}, 3))"
                    " ORDER BY ts LIMIT 400 FORMAT JSON"
                )
                body = json.dumps(
                    {
                        "slot": slot,
                        "timeline": (timeline["data"] or [None])[0],
                        "events": events["data"],
                    }
                ).encode()
                self._send(200, body, "application/json")
            except Exception as e:
                self._send(502, json.dumps({"error": str(e)}).encode(), "application/json")
        elif parsed.path in ("/", "/index.html"):
            with open(os.path.join(HERE, "index.html"), "rb") as f:
                self._send(200, f.read(), "text/html; charset=utf-8")
        else:
            self._send(404, b"not found", "text/plain")

    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass  # keep container logs quiet


if __name__ == "__main__":
    print(f"attmon web ui on :{PORT} -> {CLICKHOUSE_URL}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
