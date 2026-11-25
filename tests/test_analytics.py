"""Synthetic analytics fixtures; no Gateway, Telegram or private session data."""
import json
import os
import runpy
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
RENDERER = ROOT / "tools" / "render-limits-analytics"
MODULE = runpy.run_path(str(RENDERER))


def report():
    return {
        "sessions": [
            {"key": "agent:main:telegram:group:-100123:topic:17",
             "label": "Example group / Example topic", "usage": {"totalTokens": 1200}},
            {"key": "agent:other:telegram:group:-100123:topic:17",
             "label": "Example group / Example topic", "usage": {"totalTokens": 800}},
            {"key": "agent:main:telegram:direct:123", "usage": {"totalTokens": 500}},
        ],
        "totals": {"totalTokens": 2500},
        "cacheStatus": {"status": "fresh", "pendingFiles": 0},
        "aggregates": {"sessionCount": 3, "daily": [{"date": "2026-01-02", "tokens": 2500}]},
    }


class AnalyticsTests(unittest.TestCase):
    def test_groups_and_topics_aggregate_across_agents(self):
        result = MODULE["summarise"](report())
        self.assertEqual(dict(result["groups"]), {"-100123": 2000})
        self.assertEqual(dict(result["topics"]), {("-100123", "17"): 2000})
        self.assertEqual(result["total"], 2500)
        self.assertTrue(result["complete"])

    def test_incomplete_results_are_not_presented_as_complete(self):
        value = report()
        value["aggregates"]["sessionCount"] = 1001
        value["sessions"][0]["usage"] = {}
        result = MODULE["summarise"](value)
        self.assertFalse(result["complete"])
        self.assertTrue(result["truncated"])
        self.assertEqual(result["missing"], 1)

    def test_explicit_and_environment_zone(self):
        with patch.dict(os.environ, {"OPENCLAW_USAGE_TIMEZONE": "UTC"}):
            self.assertEqual(MODULE["resolve_zone"]("Asia/Tokyo").key, "Asia/Tokyo")
            self.assertEqual(MODULE["resolve_zone"]("not/a-zone").key, "UTC")

    def test_fixture_produces_two_private_pngs(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            fixture = work / "fixture.json"
            fixture.write_text(json.dumps({"today": report(), "all": report()}))
            groups, topics = work / "groups.png", work / "topics.png"
            subprocess.run(
                [sys.executable, str(RENDERER), str(groups), str(topics),
                 "--timezone", "Asia/Tokyo", "--fixture", str(fixture)],
                check=True, timeout=40, capture_output=True, text=True,
            )
            for file in (groups, topics):
                with Image.open(file) as image:
                    self.assertEqual(image.format, "PNG")
                    self.assertEqual(image.width, 1200)
                    image.verify()
                self.assertEqual(file.stat().st_mode & 0o777, 0o600)
            self.assertFalse(list(work.glob("*.tmp")))


if __name__ == "__main__":
    unittest.main()
