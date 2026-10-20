#!/usr/bin/env bash
set -euo pipefail

AGENT_ID=""
TIMEZONE="${OPENCLAW_USAGE_TIMEZONE:-UTC}"
RESTART=0

usage() {
  cat <<'EOF'
Usage:
  ./install.sh [--agent AGENT_ID] [--timezone TZ] [--restart]

Without --agent the script selects the single/default OpenClaw agent as the usage source.
The Telegram header itself is applied to all agents on this Gateway.
By default the Gateway is NOT restarted.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent)
      AGENT_ID="$2"
      shift 2
      ;;
    --timezone)
      TIMEZONE="$2"
      shift 2
      ;;
    --restart)
      RESTART=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

command -v openclaw >/dev/null
command -v python3 >/dev/null
command -v node >/dev/null
command -v systemctl >/dev/null

OPENCLAW_BIN="$(command -v openclaw)"
OPENCLAW_BIN_DIR="$(dirname "$OPENCLAW_BIN")"
NODE_BIN="$(command -v node)"
NODE_BIN_DIR="$(dirname "$NODE_BIN")"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="$HOME/.openclaw/workspace"
TOOLS_DST="$WORKSPACE/tools"
PLUGIN_DST="$HOME/.openclaw/local-plugins/telegram-response-header"
SYSTEMD_DST="$HOME/.config/systemd/user"

mkdir -p "$TOOLS_DST" "$PLUGIN_DST" "$SYSTEMD_DST"

if [[ -z "$AGENT_ID" ]]; then
  AGENT_ID="$(
    openclaw agents list --json | python3 -c '
import json, sys
data=json.load(sys.stdin)
defaults=[a.get("id") for a in data if a.get("isDefault") is True and a.get("id")]
if len(defaults)==1:
    print(defaults[0])
elif len(data)==1 and data[0].get("id"):
    print(data[0]["id"])
else:
    raise SystemExit("Cannot determine agent; rerun with --agent <id>")
'
  )"
fi

STAMP="$(date +%Y%m%d-%H%M%S)"

backup_if_exists() {
  local p="$1"
  if [[ -e "$p" ]]; then
    cp -a "$p" "$p.bak-$STAMP"
  fi
}

backup_if_exists "$TOOLS_DST/codex-usage-header"
backup_if_exists "$TOOLS_DST/codex-usage-cache-update"
backup_if_exists "$TOOLS_DST/render-limits-png"
backup_if_exists "$SYSTEMD_DST/codex-usage-cache.service"
backup_if_exists "$SYSTEMD_DST/codex-usage-cache.timer"

install -m 0755 "$ROOT/tools/codex-usage-header"   "$TOOLS_DST/codex-usage-header"

install -m 0755 "$ROOT/tools/codex-usage-cache-update"   "$TOOLS_DST/codex-usage-cache-update"
install -m 0755 "$ROOT/tools/render-limits-png" "$TOOLS_DST/render-limits-png"

if ! python3 -c 'from PIL import Image, ImageDraw, ImageFont' >/dev/null 2>&1; then
  echo "WARNING: Pillow is missing; PNG reports need: sudo apt install python3-pil" >&2
fi

# Preserve existing plugin files before updating; never erase unrelated data.
if [[ -f "$PLUGIN_DST/index.js" ]]; then
  cp -a "$PLUGIN_DST" "$PLUGIN_DST.bak-$STAMP"
fi
mkdir -p "$PLUGIN_DST"
cp -a "$ROOT/plugin/." "$PLUGIN_DST/"

sed \
  -e "s|__AGENT_ID__|$AGENT_ID|g" \
  -e "s|__TIMEZONE__|$TIMEZONE|g" \
  -e "s|__OPENCLAW_BIN_DIR__|$OPENCLAW_BIN_DIR|g" \
  -e "s|__NODE_BIN_DIR__|$NODE_BIN_DIR|g" \
  "$ROOT/systemd/codex-usage-cache.service" \
  > "$SYSTEMD_DST/codex-usage-cache.service"

install -m 0644   "$ROOT/systemd/codex-usage-cache.timer"   "$SYSTEMD_DST/codex-usage-cache.timer"

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"

systemctl --user daemon-reload
systemctl --user enable --now codex-usage-cache.timer

openclaw plugins install --link   "$PLUGIN_DST"   --force   --accept-capabilities

openclaw plugins enable   telegram-response-header   --accept-capabilities

echo "Note: To show the actual model on provider-owned Telegram sends, an owner"
echo "must explicitly grant the documented conversation-hook access."

echo
echo "Agent: $AGENT_ID"
echo "Timezone: $TIMEZONE"

echo
echo "Refreshing usage cache..."
if ! OPENCLAW_USAGE_AGENT="$AGENT_ID" OPENCLAW_USAGE_TIMEZONE="$TIMEZONE" \
  "$TOOLS_DST/codex-usage-cache-update"; then
  echo "WARNING: initial cache refresh failed; timer will retry." >&2
fi

echo
echo "Plugin:"
openclaw plugins inspect telegram-response-header --runtime --json

echo
echo "Timer:"
systemctl --user list-timers codex-usage-cache.timer --all --no-pager || true

echo
echo "Cache:"
python3 - "$WORKSPACE/codex-usage-current.json" <<'PY'
import json, sys
try:
    with open(sys.argv[1], encoding="utf-8") as handle:
        data = json.load(handle)
    print("Cache complete:", data.get("complete", False))
    print("Available subscriptions:", data.get("availableCount", 0))
except (OSError, ValueError) as exc:
    print("Cache not available:", type(exc).__name__)
PY

if [[ "$RESTART" -eq 1 ]]; then
  echo
  echo "Restarting Gateway..."
  openclaw gateway restart || true
  echo "Gateway restart may time out before readiness; verify with:"
  echo "  openclaw gateway status --deep"
else
  echo
  echo "Gateway was NOT restarted."
  echo "When safe, run:"
  echo "  openclaw gateway restart"
  echo "Then verify:"
  echo "  openclaw gateway status --deep"
fi
