# Compatibility

## Supported baseline

- Validated behavior on an OpenClaw 2026.10.4 deployment using the originating private implementation.
- This public English-only release retains those hook contracts but requires its own independent
  end-to-end installation smoke test before claiming that an exact host/version combination is verified.
- Node.js 22+ as required by the installed OpenClaw host (follow OpenClaw's own requirements).
- Linux with user-level systemd for the bundled installer and periodic refresh.
- Python 3.10+ with Pillow for PNG reports.

## OpenClaw hooks

The plugin registers:
- `reply_payload_sending` and `message_sending`: reply modification, with duplicate-header checks.
- `model_call_started` and `model_call_ended`: model-call metadata.
- `llm_input` and `llm_output`: runtime model observations, requiring explicit conversation access.

Hooks are optional runtime observations, not guarantees that every transport or future OpenClaw
harness emits identical metadata. If the actual model is not provable for a reply, the plugin displays `M:?`.

## Future versions

The package declares a minimum compatible OpenClaw version of 2026.10.4 and follows later
stable releases on a **best-effort** basis. SemVer/package range is not proof of API compatibility.
GitHub Actions includes source checks and an upstream-latest probe, but a green workflow does
not prove every Telegram route or supported model backend. We will adjust integrations as
future OpenClaw APIs change.

## Other operating systems

macOS and Windows are not supported by the Linux/systemd installer. The plugin source
may be portable, but no cross-platform installer or refresh scheduler is shipped.
