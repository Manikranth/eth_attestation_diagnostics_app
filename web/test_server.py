import json
import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))
import server


class DiagnosticsFilterTest(unittest.TestCase):
    def fetch_diagnostics(self, query, ch_return=None):
        calls = []

        def fake_ch_query(sql):
            calls.append(sql)
            return ch_return or {"data": [{"epoch": 12, "slot": 384}]}

        handler = server.Handler.__new__(server.Handler)
        handler.path = f"/api/diagnostics{query}"
        sent = {}

        def capture_send(code, body, ctype):
            sent["code"] = code
            sent["body"] = body
            sent["ctype"] = ctype

        handler._send = capture_send
        with patch.object(server, "ch_query", side_effect=fake_ch_query):
            server.Handler.do_GET(handler)
        sent["json"] = json.loads(sent["body"])
        return calls, sent

    def test_exact_slot_filter_queries_only_that_slot(self):
        calls, body = self.fetch_diagnostics("?slot=384")

        self.assertEqual(body["json"]["rows"], [{"epoch": 12, "slot": 384}])
        self.assertEqual(len(calls), 1)
        self.assertIn("WHERE slot = 384", calls[0])
        self.assertNotIn("max(epoch)", calls[0])

    def test_slot_range_filter_queries_that_range(self):
        calls, body = self.fetch_diagnostics("?from_slot=100&to_slot=140")

        self.assertEqual(body["json"]["rows"], [{"epoch": 12, "slot": 384}])
        self.assertEqual(len(calls), 1)
        self.assertIn("WHERE slot >= 100 AND slot <= 140", calls[0])
        self.assertNotIn("max(epoch)", calls[0])

    def test_slot_range_can_filter_validator_indices(self):
        calls, _ = self.fetch_diagnostics("?from_slot=100&to_slot=140&validators=12,34")

        self.assertEqual(len(calls), 1)
        self.assertIn("validator_index IN (12,34)", calls[0])

    def test_slot_range_can_filter_validator_pubkeys(self):
        calls, _ = self.fetch_diagnostics("?from_slot=100&to_slot=140&pubkeys=0xabc,0xdef")

        self.assertEqual(len(calls), 1)
        self.assertIn("validator_pubkey IN ('0xabc','0xdef')", calls[0])

    def test_bad_slot_range_returns_400(self):
        calls, body = self.fetch_diagnostics("?from_slot=200&to_slot=100")

        self.assertEqual(calls, [])
        self.assertEqual(body["code"], 400)
        self.assertEqual(body["json"]["error"], "bad slot range")

    def test_exact_epoch_filter_queries_only_that_epoch(self):
        calls, _ = self.fetch_diagnostics("?epoch=12")

        self.assertEqual(len(calls), 1)
        self.assertIn("WHERE epoch = 12", calls[0])
        self.assertNotIn("max(epoch)", calls[0])

    def test_bad_exact_filter_returns_400(self):
        calls, body = self.fetch_diagnostics("?slot=not-a-number")

        self.assertEqual(calls, [])
        self.assertEqual(body["code"], 400)
        self.assertEqual(body["json"]["error"], "bad slot")

    def test_generic_field_filter_uses_whitelisted_column(self):
        calls, _ = self.fetch_diagnostics("?field=fault_attribution&value=perfect")

        self.assertEqual(len(calls), 1)
        self.assertIn("toString(fault_attribution) = 'perfect'", calls[0])

    def test_unknown_generic_field_returns_400(self):
        calls, body = self.fetch_diagnostics("?field=not_a_column&value=perfect")

        self.assertEqual(calls, [])
        self.assertEqual(body["code"], 400)
        self.assertEqual(body["json"]["error"], "bad field")

    def test_serves_datadog_csv_module(self):
        handler = server.Handler.__new__(server.Handler)
        handler.path = "/datadog_csv.mjs"
        sent = {}

        def capture_send(code, body, ctype):
            sent["code"] = code
            sent["body"] = body
            sent["ctype"] = ctype

        handler._send = capture_send
        server.Handler.do_GET(handler)

        self.assertEqual(sent["code"], 200)
        self.assertEqual(sent["ctype"], "text/javascript; charset=utf-8")
        self.assertIn(b"parseDatadogCsv", sent["body"])


if __name__ == "__main__":
    unittest.main()
