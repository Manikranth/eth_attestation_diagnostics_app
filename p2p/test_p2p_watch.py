import unittest
from unittest.mock import patch
import sys
import types
from pathlib import Path
from unittest.mock import mock_open

requests_stub = types.SimpleNamespace(Session=lambda: types.SimpleNamespace())
sys.modules.setdefault("requests", requests_stub)
sys.path.insert(0, str(Path(__file__).resolve().parent))
import p2p_watch


class ValidatorDiscoveryTest(unittest.TestCase):
    def test_discovers_watch_set_from_log_pubkeys(self):
        rows = [
            {"validator_pubkey": "0xabc", "validator_name": "0xabc"},
            {"validator_pubkey": "0xdef", "validator_name": "validator-def"},
        ]
        resolved = {
            "data": [
                {"index": "101", "validator": {"pubkey": "0xabc"}},
                {"index": "202", "validator": {"pubkey": "0xdef"}},
            ]
        }

        with patch.object(p2p_watch, "ch_json", return_value={"data": rows}), \
             patch.object(p2p_watch, "beacon_get", return_value=resolved), \
             patch.object(p2p_watch, "upsert_local_validators") as upsert:
            validators = p2p_watch.get_monitored_validators()

        self.assertEqual(
            validators,
            {
                101: {"pubkey": "0xabc", "name": "0xabc"},
                202: {"pubkey": "0xdef", "name": "validator-def"},
            },
        )
        upsert.assert_called_once_with(validators)

    def test_duties_refresh_uses_discovered_validator_indices(self):
        p2p_watch.MONITORED_VALIDATORS = {
            101: {"pubkey": "0xabc", "name": "0xabc"},
            202: {"pubkey": "0xdef", "name": "validator-def"},
        }
        data = {
            "data": [
                {"slot": "64", "index": "3", "validators": ["55", "101"]},
                {"slot": "65", "index": "4", "validators": ["202", "303"]},
            ]
        }

        try:
            with patch.object(p2p_watch, "beacon_get", return_value=data):
                duties = p2p_watch.Duties()
                duties.refresh(2)
        finally:
            p2p_watch.MONITORED_VALIDATORS = {}

        self.assertEqual(duties.duty[64], [(101, 3, 1)])
        self.assertEqual(duties.duty[65], [(202, 4, 0)])

    def test_discovers_pubkeys_from_local_validator_log_when_clickhouse_empty(self):
        log_data = (
            'Jul 19 18:32:14.454 INFO  Enabled validator '
            'signing_method: "local_keystore", voting_pubkey: "0xabc"\n'
            'Jul 19 18:32:16.643 DEBUG Validator without index '
            'pubkey: 0xdef, fee_recipient: "0x123"\n'
        )

        with patch.object(p2p_watch, "ch_json", return_value={"data": []}), \
             patch("builtins.open", mock_open(read_data=log_data)), \
             patch.object(p2p_watch.os.path, "exists", return_value=True):
            identities = p2p_watch.discover_validator_log_identities()

        self.assertEqual(identities, {"0xabc": "0xabc", "0xdef": "0xdef"})

    def test_refresh_epoch_window_keeps_current_epoch_when_next_epoch_fails(self):
        class FakeDuties:
            def __init__(self):
                self.loaded_epochs = set()
                self.calls = []

            def refresh(self, epoch):
                self.calls.append(epoch)
                if epoch == 11:
                    raise RuntimeError("next epoch unavailable")
                self.loaded_epochs.add(epoch)

        duties = FakeDuties()
        p2p_watch.refresh_epoch_window(duties, 10)

        self.assertEqual(duties.calls, [10, 11])
        self.assertEqual(duties.loaded_epochs, {10})


if __name__ == "__main__":
    unittest.main()
