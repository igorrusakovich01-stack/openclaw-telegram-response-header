#!/usr/bin/env bash
set -euo pipefail

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"

systemctl --user disable --now codex-usage-cache.timer 2>/dev/null || true
systemctl --user stop codex-usage-cache.service 2>/dev/null || true

rm -f "$HOME/.config/systemd/user/codex-usage-cache.timer"
rm -f "$HOME/.config/systemd/user/codex-usage-cache.service"

systemctl --user daemon-reload

openclaw plugins disable telegram-response-header 2>/dev/null || true

echo "Disabled telegram-response-header and removed its systemd timer/service."
echo "Kept tools, cache, plugin source and all OpenClaw credentials/state."
echo "Restart Gateway when safe:"
echo "  openclaw gateway restart"
