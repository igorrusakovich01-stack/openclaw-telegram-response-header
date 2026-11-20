# Security and privacy

## What this plugin accesses

- OpenClaw's local OpenAI OAuth profile inventory via `openclaw models auth list`.
- OpenClaw's `codex.accountUsage` Gateway RPC, to obtain provider-reported usage.
- Optional model lifecycle events (`llm_input`, `llm_output`) when the operator explicitly sets
  `plugins.entries.telegram-response-header.hooks.allowConversationAccess=true`.

Enabling conversation access authorizes the plugin to *receive* content-bearing events. The implementation
uses session identifiers and provider/model identifiers only and does not intentionally persist prompts,
messages, tool results, or transcripts. Audit the source before granting this permission.

## Private reports

The `/limits` report is restricted to an authorized Telegram sender ID in a one-to-one chat.
It is not intended for public group or topic use.

The normal Telegram W quota header is owner-only and disabled by default. Each Telegram topic independently controls both W and M; other users never see W.
The plugin avoids attributing a message to the last sender in a group/topic;
it uses exact event identifiers and a bounded short-lived metadata-only map.
Unidentified or contradictory topic routing results in no automatic header. The plugin's generated report can include
OAuth profile email addresses, which are private account metadata.

## Local data

Private per-topic settings are stored in `~/.openclaw/telegram-response-header-topics.json`, written atomically with mode 0600. Any identifiable Telegram participant in a forum topic may change that topic's settings via `/header`, even without OpenClaw owner authorization. This is intentional: any participant can disable M or enable W for the topic, but W remains visible only on replies verified as belonging to the configured owner. Do not commit or share the file, as it contains Telegram group/topic identifiers.

The usage cache is kept on the machine at `~/.openclaw/workspace/codex-usage-current.json`.
The updater writes atomically with file mode 0600. Generated PNG files are kept in a local
private directory. No quota data, profile IDs, emails, tokens, or Telegram IDs belong in Git.

## Installation review

Review scripts before running them. `install.sh` manages systemd **user** units and enables
the plugin on the local OpenClaw installation. It does not create new OpenAI OAuth credentials.
It backs up a previous installed plugin directory if one is present.

## Reporting vulnerabilities

Please open a private GitHub security advisory rather than a public issue for suspected
token exposure, authorization bypass, or information disclosure. Do not attach real
credentials, profile exports, transcripts, or production usage caches.
