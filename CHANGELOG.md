# Changelog

All notable changes to this project will be documented here.

## [1.0.0] - 2026-10-20

### Added
- Standalone English-only OpenClaw Telegram plugin for cached OpenAI quota (W) and observed model (M).
- Private /limits command with on-demand PNG rendering and text fallback.
- Support for the reply_payload_sending and message_sending delivery hooks.
- Optional observed-model hooks, with explicit conversation-hook permission.
- Safe, atomic quota cache refresh; Linux systemd user timer.
- Configurable IANA time zone and report heading; UTC by default.
- Documentation, demo illustrations based on synthetic data, and CI checks.

### Limits
- OpenAI account usage currently requires the OpenClaw codex.accountUsage RPC and supported OAuth profiles.
- Linux with systemd user services is the only supported installer target.
- Future OpenClaw releases are targeted on a best-effort basis, never guaranteed.
- No automatic alerts or notifications.
