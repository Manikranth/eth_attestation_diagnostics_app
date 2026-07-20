import unittest
from unittest.mock import patch
import sys
import types
from unittest.mock import mock_open

requests_stub = types.SimpleNamespace(Session=lambda: types.SimpleNamespace())
sys.modules.setdefault("requests", requests_stub)

indexer = __import__("indexer.indexer", fromlist=["indexer"])


class ValidatorDiscoveryTest(unittest.TestCase):
    def test_discovers_validators_from_log_pubkeys(self):
        rows = [
            {
                "validator_pubkey": "0xabc",
                "validator_name": "0xabc",
            },
            {
                "validator_pubkey": "0xdef",
                "validator_name": "validator-def",
            },
        ]
        resolved = {
            "data": [
                {
                    "index": "11",
                    "validator": {"pubkey": "0xabc"},
                    "status": "active_ongoing",
                },
                {
                    "index": "12",
                    "validator": {"pubkey": "0xdef"},
                    "status": "pending_initialized",
                },
            ]
        }

        with patch.object(indexer, "ch_json", return_value={"data": rows}), \
             patch.object(indexer, "beacon_get", return_value=resolved), \
             patch.object(indexer, "upsert_local_validators") as upsert:
            validators = indexer.get_monitored_validators()

        self.assertEqual(
            validators,
            {
                11: {"pubkey": "0xabc", "name": "0xabc"},
                12: {"pubkey": "0xdef", "name": "validator-def"},
            },
        )
        upsert.assert_called_once_with(validators)

    def test_process_epoch_uses_discovered_validator_set_only(self):
        validators = {
            22: {"pubkey": "0x22", "name": "validator-22"},
            33: {"pubkey": "0x33", "name": "validator-33"},
        }
        committees = {
            320: {7: [22, 44]},
            321: {9: [55, 33]},
        }

        with patch.object(indexer, "get_committees", return_value=committees), \
             patch.object(indexer, "canonical_root_at", return_value="0xroot"), \
             patch.object(indexer, "get_block_attestations", return_value=None), \
             patch.object(indexer, "get_block_facts", return_value={}), \
             patch.object(indexer, "ch_query") as ch_query:
            count = indexer.process_epoch(10, 0, validators)

        self.assertEqual(count, 2)
        payload = ch_query.call_args.kwargs["data"].splitlines()
        self.assertIn('"validator_index": 22', payload[0])
        self.assertIn('"validator_pubkey": "0x22"', payload[0])
        self.assertIn('"validator_name": "validator-22"', payload[0])
        self.assertIn('"validator_index": 33', payload[1])

    def test_discovers_pubkeys_from_local_validator_log_when_clickhouse_empty(self):
        log_data = (
            'Jul 19 18:32:14.454 INFO  Enabled validator '
            'signing_method: "local_keystore", voting_pubkey: "0xabc"\n'
            'Jul 19 18:32:16.643 DEBUG Validator without index '
            'pubkey: 0xdef, fee_recipient: "0x123"\n'
        )

        with patch.object(indexer, "ch_json", return_value={"data": []}), \
             patch("builtins.open", mock_open(read_data=log_data)), \
             patch.object(indexer.os.path, "exists", return_value=True):
            identities = indexer.discover_validator_log_identities()

        self.assertEqual(identities, {"0xabc": "0xabc", "0xdef": "0xdef"})


if __name__ == "__main__":
    unittest.main()
