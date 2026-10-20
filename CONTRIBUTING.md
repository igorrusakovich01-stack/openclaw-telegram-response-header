# Contributing

Thanks for improving this project!

- Keep public documentation, errors, comments, and interface text in English only.
- Never commit credentials, usage caches, real Telegram IDs, profile emails, screenshots of private chats,
  private paths, or server-specific configuration.
- Keep /limits owner-only and private-chat-only. Test authorization against unauthorized senders and groups.
- Do not infer or invent provider usage data or the model used for a response.
- Make changes compatible with the documented plugin API when possible.
- Run `bash scripts/check.sh` and include tests for changed behavior.
- Keep Linux/systemd compatibility as the supported baseline. Add other platforms only when tested.
- Explain any new OpenClaw API dependency or version boundary in `docs/compatibility.md`.

Open a pull request with a concise description and instructions to reproduce and test.
