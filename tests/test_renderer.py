"""Unit and smoke tests for the PNG renderer using entirely synthetic data."""
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
RENDERER = ROOT / "tools" / "render-limits-png"


class RendererTests(unittest.TestCase):
    def test_synthetic_cache_renders_image(self):
        now = int(time.time() * 1000)
        sample = {
            "cacheGeneratedAt": now,
            "complete": True,
            "overallPercent": 67,
            "plannedRemainingPercent": 60,
            "availableCount": 2,
            "earliestResetAt": now + 86400000,
            "subscriptions": [
                {"profileId": "openai:test-one", "plan": "pro",
                 "remainingPercent": 74, "usedPercent": 26,
                 "resetAt": now + 86400000},
                {"profileId": "openai:test-two", "plan": "pro",
                 "remainingPercent": 60, "usedPercent": 40,
                 "resetAt": now + 172800000}
            ],
            "errors": []
        }
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory, "cache.json")
            target = Path(directory, "report.png")
            source.write_text(json.dumps(sample), encoding="utf-8")
            subprocess.run(
                [sys.executable, str(RENDERER), str(source), str(target),
                 "OpenAI Usage Limits", "UTC"],
                check=True, env={**os.environ, "OPENCLAW_USAGE_TIMEZONE": "UTC"},
                timeout=40, capture_output=True, text=True
            )
            with Image.open(target) as image:
                self.assertEqual(image.format, "PNG")
                self.assertEqual(image.width, 1120)
                self.assertGreater(image.height, 500)

    def test_missing_arguments_report_usage(self):
        result = subprocess.run(
            [sys.executable, str(RENDERER)],
            capture_output=True, text=True, timeout=10
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("SOURCE_JSON OUTPUT_PNG", result.stderr)


if __name__ == "__main__":
    unittest.main()
