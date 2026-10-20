#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo "Checking shell scripts..."
bash -n install.sh uninstall.sh tools/codex-usage-cache-update scripts/check.sh
echo "Checking plugin syntax..."
node --check plugin/index.js
echo "Checking Python syntax..."
python3 -m py_compile tools/codex-usage-header tools/render-limits-png tests/test_renderer.py
echo "Checking JSON syntax..."
python3 -m json.tool plugin/openclaw.plugin.json >/dev/null
python3 -m json.tool plugin/package.json >/dev/null
echo "Checking for non-English characters in published source..."
python3 - <<'PY'
from pathlib import Path
import re
root = Path(".")
for base in ("plugin", "tools", "docs", "tests", "scripts", "systemd"):
    for file in (root / base).rglob("*"):
        if not file.is_file() or file.suffix in (".png", ".pyc"):
            continue
        if file.name.endswith(".svg"):
            data = file.read_text("utf-8")
        elif file.suffix in (".json", ".md", ".js", ".mjs", ".py", ".sh", ".service", ".timer") or file.name in ("render-limits-png", "codex-usage-header", "codex-usage-cache-update"):
            data = file.read_text("utf-8")
        else:
            continue
        if re.search(r"[\u0400-\u052f]", data):
            raise SystemExit(f"Non-English text found in {file}")
print("Text check passed")
PY
echo "Running Node tests..."
node --test tests/*.test.mjs
echo "Running Python tests..."
python3 -m unittest discover -s tests -p 'test_*.py' -v
echo "All checks passed."
