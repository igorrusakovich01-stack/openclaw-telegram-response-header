# Guidance for AI contributors

Maintain a small OpenClaw Telegram delivery plugin.

Constraints:
1. No hardcoded user, agent, profile, email, machine, host, locale, or server identity.
2. No credentials or usage JSON in commits, tests, screenshots, or logs.
3. The default interface and all public documentation are English only.
4. Usage data must originate from `codex.accountUsage`; show unknown when unavailable.
5. Actual model labels must originate from correlated runtime observations; show `M:?` if uncertain.
6. Only add W/M to relevant Telegram reply payloads, not reasoning, progress, commands, or fallback status.
7. /limits must be restricted to the authorized owner in direct Telegram chats; no LLM call for the report.
8. No unsolicited alerts or scheduled Telegram notifications.
9. The Linux installer should not erase local configuration or credentials and should not force a Gateway restart.
10. Claims of compatibility with future versions are best effort; do not guarantee untested APIs.

Verify scripts and test with `bash scripts/check.sh` before requesting review.
