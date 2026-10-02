#!/usr/bin/env python3
"""Tests for scripts/set_pages_env.py.

Run with:  python -m unittest discover -s scripts/tests -v

Everything runs against synthetic project objects: no account, no network, no credentials. The
point of these tests is the guard, not the call: the script must never write a configuration
that drops the R2 bindings, and it must notice if it did.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from set_pages_env import merge, parse_sets, r2_bindings, verify  # noqa: E402


def project() -> dict:
    """A project shaped like the API returns one: two environments, bindings, variables."""
    return {
        "name": "melee-web",
        "deployment_configs": {
            "production": {
                "compatibility_date": "2026-09-01",
                "r2_buckets": [{"name": "ASSETS_R2", "bucket_name": "melee-web-assets"}],
                "env_vars": {},
            },
            "preview": {
                "compatibility_date": "2026-09-01",
                "r2_buckets": [
                    {"name": "ASSETS_R2", "bucket_name": "melee-web-assets"},
                    {"name": "PHASE0_DISC", "bucket_name": "melee-phase0-disc"},
                ],
                "env_vars": {"EXISTING": {"value": "keep-me"}},
            },
        },
    }


class MergeTest(unittest.TestCase):
    def test_bindings_and_the_other_environment_survive(self) -> None:
        configs = project()["deployment_configs"]
        merged = merge(configs, "preview", {"ACCESS_AUD": "aud-value"})
        self.assertEqual(r2_bindings(merged, "preview"), r2_bindings(configs, "preview"))
        self.assertEqual(merged["production"], configs["production"])

    def test_existing_variables_are_kept_and_new_ones_added(self) -> None:
        merged = merge(project()["deployment_configs"], "preview",
                       {"ACCESS_AUD": "aud-value", "ACCESS_TEAM_DOMAIN": "team.cloudflareaccess.com"})
        variables = merged["preview"]["env_vars"]
        self.assertEqual(variables["EXISTING"], {"value": "keep-me"})
        self.assertEqual(variables["ACCESS_AUD"], {"value": "aud-value"})
        self.assertEqual(variables["ACCESS_TEAM_DOMAIN"], {"value": "team.cloudflareaccess.com"})

    def test_a_variable_is_overwritten_not_duplicated(self) -> None:
        configs = project()["deployment_configs"]
        configs["preview"]["env_vars"]["ACCESS_AUD"] = {"value": "stale"}
        merged = merge(configs, "preview", {"ACCESS_AUD": "fresh"})
        self.assertEqual(merged["preview"]["env_vars"]["ACCESS_AUD"], {"value": "fresh"})
        self.assertEqual(sorted(merged["preview"]["env_vars"]), ["ACCESS_AUD", "EXISTING"])

    def test_the_input_is_not_mutated(self) -> None:
        configs = project()["deployment_configs"]
        merge(configs, "preview", {"ACCESS_AUD": "aud-value"})
        self.assertEqual(configs["preview"]["env_vars"], {"EXISTING": {"value": "keep-me"}})

    def test_an_unknown_environment_is_refused(self) -> None:
        with self.assertRaises(SystemExit) as caught:
            merge(project()["deployment_configs"], "staging", {"ACCESS_AUD": "aud-value"})
        self.assertIn("no 'staging' deployment configuration", str(caught.exception))


class VerifyTest(unittest.TestCase):
    def setUp(self) -> None:
        self.before = project()["deployment_configs"]
        self.expected = {"ACCESS_AUD": "aud-value"}
        self.after = merge(self.before, "preview", self.expected)

    def test_a_correct_write_has_nothing_to_report(self) -> None:
        self.assertEqual(verify(self.before, self.after, "preview", self.expected), [])

    def test_a_dropped_binding_is_reported(self) -> None:
        self.after["preview"]["r2_buckets"] = [{"name": "ASSETS_R2", "bucket_name": "melee-web-assets"}]
        problems = verify(self.before, self.after, "preview", self.expected)
        self.assertTrue(any("R2 bindings" in problem for problem in problems), problems)

    def test_a_variable_that_did_not_land_is_reported(self) -> None:
        self.after["preview"]["env_vars"].pop("ACCESS_AUD")
        problems = verify(self.before, self.after, "preview", self.expected)
        self.assertTrue(any("did not read back" in problem for problem in problems), problems)

    def test_a_variable_that_landed_with_the_wrong_value_is_reported(self) -> None:
        self.after["preview"]["env_vars"]["ACCESS_AUD"] = {"value": "something-else"}
        problems = verify(self.before, self.after, "preview", self.expected)
        self.assertTrue(any("did not read back" in problem for problem in problems), problems)

    def test_a_lost_environment_is_reported(self) -> None:
        del self.after["production"]
        problems = verify(self.before, self.after, "preview", self.expected)
        self.assertTrue(any("environments changed" in problem for problem in problems), problems)

    def test_an_untouched_key_that_changed_is_reported(self) -> None:
        self.after["preview"]["compatibility_date"] = "2026-10-01"
        problems = verify(self.before, self.after, "preview", self.expected)
        self.assertTrue(any("compatibility_date" in problem for problem in problems), problems)


class ParseSetsTest(unittest.TestCase):
    def test_a_pair_is_parsed(self) -> None:
        self.assertEqual(parse_sets(["A=1", "B=two=three"]), {"A": "1", "B": "two=three"})

    def test_a_value_may_contain_equals_signs(self) -> None:
        self.assertEqual(parse_sets(["AUD=a=b"]), {"AUD": "a=b"})

    def test_a_missing_value_is_refused(self) -> None:
        for bad in ["NOEQUALS", "NAME=", "=value"]:
            with self.subTest(bad=bad), self.assertRaises(SystemExit):
                parse_sets([bad])


if __name__ == "__main__":
    unittest.main()
