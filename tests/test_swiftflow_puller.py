import gzip
import json
import tempfile
import unittest
from pathlib import Path

from api.swiftflow_puller import load_seen, matches, normalize_lead, read_domains, save_seen


class SwiftFlowPullerTests(unittest.TestCase):
    def test_read_domains_normalizes_and_deduplicates(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            with gzip.open(path / "domains.gz", "wt") as stream:
                stream.write("Example.COM\nexample.com.\ninvalid\nother.io\n")
            self.assertEqual(read_domains(path), ["example.com", "other.io"])

    def test_normalize_and_filter(self):
        lead = normalize_lead({"name": "Acme", "industry": "Marketing Automation", "employees_count": 12}, "acme.io")
        self.assertEqual(lead["domain"], "acme.io")
        self.assertEqual(len(lead["id"]), 24)
        self.assertTrue(matches(lead, {"automation"}, set(), 10, 20))
        self.assertFalse(matches(lead, {"construction"}, set(), None, None))

    def test_seen_state_round_trip(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "state" / "seen.json"
            save_seen(path, {"b", "a"})
            self.assertEqual(json.loads(path.read_text()), ["a", "b"])
            self.assertEqual(load_seen(path), {"a", "b"})


if __name__ == "__main__":
    unittest.main()
