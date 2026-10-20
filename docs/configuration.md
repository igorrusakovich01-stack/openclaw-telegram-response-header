# Configuration

## Required

1. Install OpenClaw with Telegram enabled and an OpenAI OAuth profile.
2. Install this plugin with `./install.sh --agent main --timezone UTC` (adjust to your agent).
3. Set the numeric Telegram owner ID used for /limits. Keep the actual value off Git:

```bash
openclaw config set plugins.entries.telegram-response-header.config.ownerTelegramId '"123456789"' --strict-json
```

Replace the example ID. Use your bot's /whoami command or Telegram's own account tools to find your ID.

## Optional

```bash
openclaw config set plugins.entries.telegram-response-header.config.reportTitle '"OpenAI Usage Limits"' --strict-json
openclaw config set plugins.entries.telegram-response-header.config.timeZone '"UTC"' --strict-json
```

The systemd usage collector uses the time zone passed to `install.sh --timezone`.
Set the plugin `timeZone` to the same IANA name for report consistency.

## Actual model in native Telegram delivery

A direct Telegram response may pass through `message_sending` instead of
`reply_payload_sending`. To capture model metadata from the language-model
lifecycle hooks, optionally grant:

```bash
openclaw config set plugins.entries.telegram-response-header.hooks.allowConversationAccess true --strict-json
```

**Privacy implication:** this permission authorizes the plugin to receive content-bearing
lifecycle events. This implementation retains only model and session metadata.
Without the permission, M may be unknown for some delivery routes.

## Refresh and verification

```bash
systemctl --user status codex-usage-cache.timer --no-pager
openclaw plugins inspect telegram-response-header --runtime --json
openclaw gateway status --deep
```

The quota cache is refreshed every five minutes and considered fresh for ten minutes.
The plugin shows an unknown quota when valid data is unavailable.
