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
It is not intended for public group or topic use. The plugin's generated report can include
OAuth profile email addresses, which are private account metadata.

## Local data

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
