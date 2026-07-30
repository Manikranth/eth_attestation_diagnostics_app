import unittest
from unittest.mock import patch
import sys
import types
from unittest.mock import mock_open
import json

requests_stub = types.SimpleNamespace(Session=lambda: types.SimpleNamespace())
sys.modules.setdefault("requests", requests_stub)

indexer = __import__("indexer.indexer", fromlist=["indexer"])


class ValidatorDiscoveryTest(unittest.TestCase):
    def test_get_block_facts_records_block_and_blob_sizes(self):
        block = {
            "data": {
                "message": {
                    "body": {
                        "execution_payload": {
                            "block_number": "3309408",
                            "block_hash": "0xhash",
                        },
                        "graffiti": "0x68656c6c6f0000",
                        "blob_kzg_commitments": ["0x01", "0x02"],
                    }
                }
            }
        }
        header = {
            "data": {
                "header": {
                    "message": {
                        "proposer_index": "44",
                        "state_root": "0xstate",
                    }
                }
            }
        }
        sidecars = {
            "data": [
                {"blob": "0x" + ("11" * 4)},
                {"blob": "0x" + ("22" * 6)},
            ]
        }

        def fake_beacon_get(path, ok_404=False):
            if path == "/eth/v1/beacon/headers/320":
                return header
            if path == "/eth/v2/beacon/blocks/320":
                return block
            if path == "/eth/v1/beacon/blob_sidecars/320":
                return sidecars
            self.fail(f"unexpected beacon_get path {path}")

        with patch.object(indexer, "beacon_get", side_effect=fake_beacon_get), \
             patch.object(indexer, "beacon_get_bytes", return_value=b"block-bytes"):
            facts = indexer.get_block_facts(320)

        self.assertEqual(facts["block_size_bytes"], len(b"block-bytes"))
        self.assertEqual(facts["blob_size_bytes"], 10)
        self.assertEqual(facts["blob_count"], 2)

    def test_get_block_facts_records_zero_blob_size_for_block_without_blobs(self):
        header = {
            "data": {
                "header": {
                    "message": {
                        "proposer_index": "44",
                        "state_root": "0xstate",
                    }
                }
            }
        }
        block = {
            "data": {
                "message": {
                    "body": {
                        "execution_payload": {"block_number": "3309408"},
                        "blob_kzg_commitments": [],
                    }
                }
            }
        }

        def fake_beacon_get(path, ok_404=False):
            if path == "/eth/v1/beacon/headers/320":
                return header
            if path == "/eth/v2/beacon/blocks/320":
                return block
            if path == "/eth/v1/beacon/blob_sidecars/320":
                return {"data": []}
            self.fail(f"unexpected beacon_get path {path}")

        with patch.object(indexer, "beacon_get", side_effect=fake_beacon_get), \
             patch.object(indexer, "beacon_get_bytes", return_value=b"block-bytes"):
            facts = indexer.get_block_facts(320)

        self.assertEqual(facts["blob_count"], 0)
        self.assertEqual(facts["blob_size_bytes"], 0)

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

    def test_get_validator_by_index_resolves_pubkey_and_name(self):
        response = {
            "data": [
                {
                    "index": "1454766",
                    "validator": {"pubkey": "0xabc"},
                }
            ]
        }

        with patch.object(indexer, "beacon_get", return_value=response):
            validator = indexer.get_validator_by_index(1454766)

        self.assertEqual(
            validator,
            {1454766: {"pubkey": "0xabc", "name": "0xabc"}},
        )

    def test_process_slot_for_validator_reprocesses_only_matching_duty_slot(self):
        validators = {1454766: {"pubkey": "0xabc", "name": "0xabc"}}
        committees = {
            3597599: {7: [1454766, 44]},
            3597600: {8: [55, 66]},
        }

        with patch.object(indexer, "get_validator_by_index", return_value=validators), \
             patch.object(indexer, "get_target_epoch", return_value=112424), \
             patch.object(indexer, "get_committees", return_value=committees), \
             patch.object(indexer, "upsert_local_validators") as upsert, \
             patch.object(indexer, "node_is_optimistic", return_value=False), \
             patch.object(indexer, "process_epoch", return_value=1) as process_epoch:
            count = indexer.process_slot_for_validator(3597599, 1454766, genesis_time=0)

        self.assertEqual(count, 1)
        upsert.assert_called_once_with(validators)
        process_epoch.assert_called_once_with(112424, 0, validators, True)

    def test_process_slot_for_validator_rejects_unfinalized_inclusion_window(self):
        with patch.object(indexer, "get_target_epoch", return_value=112423), \
             patch.object(indexer, "get_validator_by_index") as get_validator:
            with self.assertRaisesRegex(RuntimeError, "not finalized"):
                indexer.process_slot_for_validator(3597599, 1454766, genesis_time=0)

        get_validator.assert_not_called()

    def test_process_slot_for_validator_rejects_non_matching_duty_slot(self):
        validators = {1454766: {"pubkey": "0xabc", "name": "0xabc"}}
        committees = {
            3597600: {7: [1454766, 44]},
        }

        with patch.object(indexer, "get_validator_by_index", return_value=validators), \
             patch.object(indexer, "get_target_epoch", return_value=112424), \
             patch.object(indexer, "get_committees", return_value=committees), \
             patch.object(indexer, "process_epoch") as process_epoch:
            with self.assertRaisesRegex(RuntimeError, "duty slot"):
                indexer.process_slot_for_validator(3597599, 1454766, genesis_time=0)

        process_epoch.assert_not_called()

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

    def test_target_epoch_waits_for_inclusion_window_finality(self):
        with patch.object(indexer, "get_finalized_epoch", return_value=42):
            self.assertEqual(indexer.get_target_epoch(), 40)

    def test_attestation_reward_verdicts_parse_positive_reward_components(self):
        rewards = {
            "finalized": True,
            "execution_optimistic": False,
            "data": {
                "total_rewards": [
                    {
                        "validator_index": "22",
                        "head": "0",
                        "target": "1234",
                        "source": "5678",
                    }
                ]
            },
        }

        with patch.object(indexer, "beacon_post", return_value=rewards):
            verdicts = indexer.get_attestation_reward_verdicts(10, {22})

        self.assertEqual(
            verdicts,
            {
                22: {
                    "head_correct": 0,
                    "target_correct": 1,
                    "source_correct": 1,
                }
            },
        )

    def test_attestation_reward_verdicts_require_finalized_response(self):
        rewards = {
            "finalized": False,
            "execution_optimistic": False,
            "data": {
                "total_rewards": [
                    {
                        "validator_index": "22",
                        "head": "1",
                        "target": "1",
                        "source": "1",
                    }
                ]
            },
        }

        with patch.object(indexer, "beacon_post", return_value=rewards):
            self.assertEqual(indexer.get_attestation_reward_verdicts(10, {22}), {})

    def test_process_epoch_uses_finalized_rewards_for_vote_verdicts(self):
        validators = {
            22: {"pubkey": "0x22", "name": "validator-22"},
        }
        committees = {
            321: {7: [22, 44]},
        }
        attestation = {
            "aggregation_bits": "0x03",
            "data": {
                "slot": "321",
                "index": "7",
                "beacon_block_root": "0xhead",
                "target": {"epoch": "10", "root": "0xtarget"},
                "source": {"epoch": "9", "root": "0xwrongsource"},
            },
        }
        rewards = {
            22: {
                "head_correct": 0,
                "target_correct": 1,
                "source_correct": 1,
            },
        }

        with patch.object(indexer, "get_committees", return_value=committees), \
             patch.object(indexer, "canonical_root_at", side_effect=lambda slot, floor_slot=0: "0xtarget" if slot == 320 else "0xhead"), \
             patch.object(indexer, "get_block_attestations", return_value=[attestation]), \
             patch.object(indexer, "get_block_facts", return_value={}), \
             patch.object(indexer, "slot_of_root", return_value=321), \
             patch.object(indexer, "get_attestation_reward_verdicts", return_value=rewards), \
             patch.object(indexer, "ch_query") as ch_query:
            count = indexer.process_epoch(10, 0, validators)

        self.assertEqual(count, 1)
        row = json.loads(ch_query.call_args.kwargs["data"])
        self.assertEqual(row["head_correct"], 0)
        self.assertEqual(row["target_correct"], 1)
        self.assertEqual(row["source_correct"], 1)

    def test_process_epoch_records_inclusion_block_identity(self):
        validators = {
            22: {"pubkey": "0x22", "name": "validator-22"},
        }
        committees = {
            321: {7: [22, 44]},
        }
        attestation = {
            "aggregation_bits": "0x03",
            "data": {
                "slot": "321",
                "index": "7",
                "beacon_block_root": "0xvotedhead",
                "target": {"epoch": "10", "root": "0xtarget"},
                "source": {"epoch": "9", "root": "0xsource"},
            },
        }

        def block_facts(slot):
            return {
                321: {
                    "block_on_chain": 1,
                    "duty_block_root": "0xdutyblock",
                    "exec_block_number": 1001,
                },
                322: {
                    "block_on_chain": 1,
                    "duty_block_root": "0xinclusionblock",
                    "exec_block_number": 1002,
                },
            }[slot]

        with patch.object(indexer, "get_committees", return_value=committees), \
             patch.object(indexer, "canonical_root_at", return_value="0xvotedhead"), \
             patch.object(indexer, "get_block_attestations", return_value=[attestation]), \
             patch.object(indexer, "get_block_facts", side_effect=block_facts), \
             patch.object(indexer, "slot_of_root", return_value=321), \
             patch.object(indexer, "get_attestation_reward_verdicts", return_value={22: {"head_correct": 1, "target_correct": 1, "source_correct": 1}}), \
             patch.object(indexer, "ch_query") as ch_query:
            count = indexer.process_epoch(10, 0, validators)

        self.assertEqual(count, 1)
        row = json.loads(ch_query.call_args.kwargs["data"])
        self.assertEqual(row["duty_block_root"], "0xdutyblock")
        self.assertEqual(row["attested_head_root"], "0xvotedhead")
        self.assertEqual(row["canonical_head_root"], "0xvotedhead")
        self.assertEqual(row["inclusion_slot"], 322)
        self.assertEqual(row["inclusion_block_root"], "0xinclusionblock")
        self.assertEqual(row["inclusion_exec_block_number"], 1002)

    def test_process_epoch_falls_back_to_timely_flags_when_rewards_unavailable(self):
        validators = {
            22: {"pubkey": "0x22", "name": "validator-22"},
        }
        committees = {
            321: {7: [22, 44]},
        }
        attestation = {
            "aggregation_bits": "0x03",
            "data": {
                "slot": "321",
                "index": "7",
                "beacon_block_root": "0xhead",
                "target": {"epoch": "10", "root": "0xtarget"},
                "source": {"epoch": "9", "root": "0xsource"},
            },
        }

        def canonical(slot, floor_slot=0):
            return {
                320: "0xtarget",
                321: "0xhead",
            }.get(slot, "")

        with patch.object(indexer, "get_committees", return_value=committees), \
             patch.object(indexer, "canonical_root_at", side_effect=canonical), \
             patch.object(indexer, "get_block_attestations", return_value=[attestation]), \
             patch.object(indexer, "get_block_facts", return_value={}), \
             patch.object(indexer, "slot_of_root", return_value=321), \
             patch.object(indexer, "get_attestation_reward_verdicts", return_value={}), \
             patch.object(indexer, "source_checkpoint_for_slot", return_value=(9, "0xsource")), \
             patch.object(indexer, "ch_query") as ch_query:
            count = indexer.process_epoch(10, 0, validators)

        self.assertEqual(count, 1)
        row = json.loads(ch_query.call_args.kwargs["data"])
        self.assertEqual(row["inclusion_distance"], 1)
        self.assertEqual(row["head_correct"], 1)
        self.assertEqual(row["target_correct"], 1)
        self.assertEqual(row["source_correct"], 1)

        # Same vote roots, but included at distance 2: target/source are still
        # timely; head is not timely and must match beaconcha.in's missed head.
        with patch.object(indexer, "get_committees", return_value=committees), \
             patch.object(indexer, "canonical_root_at", side_effect=canonical), \
             patch.object(indexer, "get_block_attestations", side_effect=[None, [attestation]]), \
             patch.object(indexer, "get_block_facts", return_value={}), \
             patch.object(indexer, "slot_of_root", return_value=321), \
             patch.object(indexer, "get_attestation_reward_verdicts", return_value={}), \
             patch.object(indexer, "source_checkpoint_for_slot", return_value=(9, "0xsource")), \
             patch.object(indexer, "ch_query") as ch_query:
            count = indexer.process_epoch(10, 0, validators)

        self.assertEqual(count, 1)
        row = json.loads(ch_query.call_args.kwargs["data"])
        self.assertEqual(row["inclusion_distance"], 2)
        self.assertEqual(row["head_correct"], 0)
        self.assertEqual(row["target_correct"], 1)
        self.assertEqual(row["source_correct"], 1)

    def test_process_epoch_fallback_does_not_dash_when_source_checkpoint_unavailable(self):
        validators = {
            22: {"pubkey": "0x22", "name": "validator-22"},
        }
        committees = {
            321: {7: [22, 44]},
        }
        attestation = {
            "aggregation_bits": "0x03",
            "data": {
                "slot": "321",
                "index": "7",
                "beacon_block_root": "0xhead",
                "target": {"epoch": "10", "root": "0xtarget"},
                "source": {"epoch": "9", "root": "0xsource"},
            },
        }

        def canonical(slot, floor_slot=0):
            return {
                320: "0xtarget",
                321: "0xhead",
            }.get(slot, "")

        with patch.object(indexer, "get_committees", return_value=committees), \
             patch.object(indexer, "canonical_root_at", side_effect=canonical), \
             patch.object(indexer, "get_block_attestations", side_effect=[None, [attestation]]), \
             patch.object(indexer, "get_block_facts", return_value={}), \
             patch.object(indexer, "slot_of_root", return_value=321), \
             patch.object(indexer, "get_attestation_reward_verdicts", return_value={}), \
             patch.object(indexer, "source_checkpoint_for_slot", return_value=None), \
             patch.object(indexer, "ch_query") as ch_query:
            count = indexer.process_epoch(10, 0, validators)

        self.assertEqual(count, 1)
        row = json.loads(ch_query.call_args.kwargs["data"])
        self.assertEqual(row["inclusion_distance"], 2)
        self.assertEqual(row["head_correct"], 0)
        self.assertEqual(row["target_correct"], 1)
        self.assertEqual(row["source_correct"], 1)

    def test_process_epoch_does_not_store_batch_head_as_slot_head(self):
        validators = {
            22: {"pubkey": "0x22", "name": "validator-22"},
        }
        committees = {
            320: {7: [22, 44]},
        }

        with patch.object(indexer, "get_committees", return_value=committees), \
             patch.object(indexer, "canonical_root_at", return_value="0xroot"), \
             patch.object(indexer, "get_block_attestations", return_value=None), \
             patch.object(indexer, "get_block_facts", return_value={}), \
             patch.object(indexer, "ch_query") as ch_query:
            indexer.process_epoch(10, 0, validators)

        payload = ch_query.call_args.kwargs["data"]
        self.assertNotIn("current_head_exec_block", payload)

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
