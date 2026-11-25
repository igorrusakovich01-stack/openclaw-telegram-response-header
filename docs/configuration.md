# Configuration

## Required

1. Install OpenClaw with Telegram enabled and an OpenAI OAuth profile.
2. Install this plugin with `./install.sh --agent main` (adjust to your agent).
3. Set the numeric Telegram owner ID used for /limits. Keep the actual value off Git:

```bash
openclaw config set plugins.entries.telegram-response-header.config.ownerTelegramId '"123456789"' --strict-json
```

Replace the example ID. Use your bot's /whoami command or Telegram's own account tools to find your ID.

The owner ID protects private `/limits`. Any identifiable Telegram forum-topic participant can modify that topic's W/M settings using `/header`. W is shared on ordinary replies when enabled, including previously saved W-on settings. By default W is off, M is on. Unidentified or contradictory topic routing suppresses both lines. `/header` command responses carry no model header.
The owner ID is never stored in the repository.

## Optional

```bash
openclaw config set plugins.entries.telegram-response-header.config.reportTitle '"OpenAI Usage Limits"' --strict-json
openclaw config set plugins.entries.telegram-response-header.config.timeZone '"America/New_York"' --strict-json
```

The plugin uses a valid explicit `timeZone`, then the legacy `OPENCLAW_USAGE_TIMEZONE` environment variable, then the OS zone, then UTC. All three reports and displayed W/M timestamps use the same resolved zone; cached reset times are reformatted from epoch milliseconds. The installer detects the OS zone for its collector; `--timezone` overrides that choice. Use the same zone for any separate collector consumers.

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

## Per-topic slash command

Run `/header` or `/header status` in a Telegram forum topic to inspect its
settings. Any participant who can send a Telegram message in that topic may use
`/header w on/off`, `/header m on/off`, `/header on/off`, or `/header reset`.
The command does not require OpenClaw owner authorization; the sender ID and
topic routing must be identifiable. The last valid change wins. No LLM call is needed. The same settings apply to every agent and
model routed to that group/topic, even when model routing changes.

Preferences are private local state in
`~/.openclaw/telegram-response-header-topics.json`, atomically written
with file mode 0600. Do not commit that file or its group identifiers to Git.
The owner-only `/limits` report remains a separate private-chat command.
