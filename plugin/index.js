import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const CACHE_FILE = path.join(
  os.homedir(),
  ".openclaw",
  "workspace",
  "codex-usage-current.json",
);

const RENDERER = path.join(os.homedir(), ".openclaw", "workspace", "tools", "render-limits-png");
const IMAGE_DIR = path.join(os.homedir(), ".openclaw", "workspace", ".telegram-response-header-media");
const runFile = promisify(execFile);

const CACHE_MAX_AGE_MS = 10 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const RUN_RETENTION_MS = 30 * 60 * 1000;

const prefixedRuns = new Map();
const modelByRun = new Map();
// Per-session model observations. Never store prompts or response text.
const modelBySession = new Map();

function cleanupMaps(now = Date.now()) {
  for (const [key, ts] of prefixedRuns) {
    if (now - ts > RUN_RETENTION_MS) {
      prefixedRuns.delete(key);
    }
  }

  for (const [key, value] of modelByRun) {
    if (now - value.ts > RUN_RETENTION_MS) {
      modelByRun.delete(key);
    }
  }
  for (const [key, value] of modelBySession) {
    if (now - value.ts > RUN_RETENTION_MS) modelBySession.delete(key);
  }
}

function configuredTimeZone(api) {
  return String(api?.pluginConfig?.timeZone || process.env.OPENCLAW_USAGE_TIMEZONE || "UTC");
}

function formatLocalTime(date = new Date(), api) {
  const zone = configuredTimeZone(api);
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone, day: "2-digit", month: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(date);
  } catch {
    parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "UTC", day: "2-digit", month: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(date);
  }
  const fields = Object.fromEntries(
    parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value])
  );
  return `${fields.day}.${fields.month} ${fields.hour}:${fields.minute}`;
}

async function readUsageHeader() {
  try {
    const raw = await readFile(CACHE_FILE, "utf8");
    const data = JSON.parse(raw);

    const generated = Number(data.cacheGeneratedAt);
    const age = Date.now() - generated;

    if (
      data.complete === true &&
      typeof data.header === "string" &&
      data.header.trim() &&
      Number.isFinite(generated) &&
      age >= -60_000 &&
      age <= CACHE_MAX_AGE_MS
    ) {
      return data.header.trim();
    }
  } catch {
    // Fail closed to unknown quota data.
  }

  return "W:**?%** ⬜⬜⬜⬜⬜ ~? ⚪";
}

const DEFAULT_REPORT_TITLE = "OpenAI Usage Limits";
function reportTitle(api) {
  const title = String(api.pluginConfig?.reportTitle ?? "").trim();
  return title ? title.slice(0, 64) : DEFAULT_REPORT_TITLE;
}

function formatUsageTimestamp(ms, api) {
  if (!Number.isFinite(Number(ms)) || Number(ms) <= 0) {
    return "unknown";
  }
  return formatLocalTime(new Date(Number(ms)), api);
}

function describePace(data) {
  switch (data.paceEmoji) {
    case "🟢": return "usage is on pace";
    case "🟡": return "usage is ahead of pace";
    case "🔴": return "critically low balance";
    default: return "pace unavailable";
  }
}

async function createLimitsReport(api) {
  let data;
  try {
    data = JSON.parse(await readFile(CACHE_FILE, "utf8"));
  } catch {
    return "⚠️ Usage cache is unavailable. Check the cache refresh service.";
  }

  const stamp = Number(data.cacheGeneratedAt);
  const ageMs = Date.now() - stamp;
  const fresh = Number.isFinite(stamp) &&
    ageMs >= -60_000 && ageMs <= CACHE_MAX_AGE_MS;

  const report = [
    data.header && fresh ? data.header.trim() :
      "W:**?%** ⬜⬜⬜⬜⬜ ~? ⚪",
    "M:**—** (no LLM call)",
    "",
    `📊 ${reportTitle(api)}`,
    "",
  ];

  if (!fresh) {
    report.push("⚠️ Cache is stale. Showing last-known values.");
    report.push("");
  }

  const rows = Array.isArray(data.subscriptions) ? data.subscriptions : [];
  if (rows.length === 0) {
    report.push("No verified OpenAI subscriptions are available.");
  }

  for (const row of rows) {
    const profile = typeof row.profileId === "string"
      ? row.profileId : "unknown profile";
    const email = typeof row.email === "string" && row.email.includes("@")
      ? row.email : null;
    const remaining = Number(row.remainingPercent);
    const used = Number(row.usedPercent);
    const approx = used === 0 ? "≈" : "";
    // Display actual account identity, never an internal OAuth alias, when known.
    report.push(`💳 ${email || profile}`);
    report.push(`Plan: ${typeof row.plan === "string" ? row.plan : "unknown"}`);
    report.push(`Remaining: ${Number.isFinite(remaining) ? approx + remaining + "%" : "unknown"} · used: ${Number.isFinite(used) ? used + "%" : "unknown"}`);
    report.push(`Reset: ${formatUsageTimestamp(row.resetAt, api)} (${configuredTimeZone(api)})`);
    const resetAt = Number(row.resetAt);
    if (Number.isFinite(resetAt) && resetAt > 0 && Number.isFinite(remaining)) {
      const planned = Math.max(0, Math.min(100, (resetAt - Date.now()) / WEEK_MS * 100));
      const pace = remaining <= 5 ? "🔴" : remaining >= planned ? "🟢" : "🟡";
      report.push(`On-pace target: ${planned.toFixed(1)}% ${pace}`);
    }
    report.push("");
  }

  if (data.complete === true && Number.isFinite(Number(data.overallPercent))) {
    const overall = Number(data.overallPercent);
    const approx = rows.some((row) => Number(row.usedPercent) === 0) ? "≈" : "";
    report.push(`Overall remaining: ${approx}${overall}%`);
    report.push(`Pace: ${data.paceEmoji ?? "⚪"} ${describePace(data)}`);
    if (Number.isFinite(Number(data.plannedRemainingPercent))) {
      report.push(`Planned remaining: ${data.plannedRemainingPercent}%`);
    }
    report.push(`Next reset: ${formatUsageTimestamp(data.earliestResetAt, api)}`);
  } else {
    report.push("Overall remaining: unknown (insufficient verified data)");
  }

  report.push(`Available subscriptions: ${rows.length}`);
  const excludedRows = Array.isArray(data.errors) ? data.errors : [];
  if (excludedRows.length > 0) {
    report.push(`Unavailable profiles/sources: ${excludedRows.length} (excluded from percentages)`);
    for (const error of excludedRows) {
      report.push(`• ${String(error.profileId ?? error.stage ?? "unknown").slice(0, 128)}`);
    }
  }
  report.push(`Snapshot: ${formatUsageTimestamp(stamp, api)} (${configuredTimeZone(api)})`);

  return report.join("\n");
}

async function makeLimitsImage(api) {
  await mkdir(IMAGE_DIR, { recursive: true, mode: 0o700 });

  // Best-effort cleanup; never delete other users' or differently named files.
  try {
    for (const entry of await readdir(IMAGE_DIR, { withFileTypes: true })) {
      if (!entry.isFile() || !/^limits-[a-f0-9-]{36}\.png$/u.test(entry.name)) {
        continue;
      }
      const fullPath = path.join(IMAGE_DIR, entry.name);
      const age = Date.now() - (await stat(fullPath)).mtimeMs;
      if (age > 24 * 60 * 60 * 1000) {
        await unlink(fullPath);
      }
    }
  } catch {
    // Stale media cleanup is not required for this reply.
  }

  const file = path.join(IMAGE_DIR, `limits-${randomUUID()}.png`);
  await runFile("python3", [RENDERER, CACHE_FILE, file, reportTitle(api), configuredTimeZone(api)], {
    timeout: 30_000,
    maxBuffer: 1024 * 32,
  });
  return file;
}

function ownerChatId(ctx) {
  const raw = String(ctx.senderId ?? "").trim();
  if (/^\d+$/.test(raw)) {
    return raw;
  }
  const fromSender = /^telegram:(\d+)$/u.exec(raw);
  if (fromSender) {
    return fromSender[1];
  }
  return /^telegram:(\d+)$/u.exec(String(ctx.from ?? "").trim())?.[1];
}

async function deliverLimitsImage(api, ctx) {
  let file;
  try {
    file = await makeLimitsImage(api);
  } catch (error) {
    api.logger.warn?.(`limits PNG render failed: ${error?.message ?? error}`);
    return { text: `⚠️ PNG rendering failed; sending a text report instead.\n\n${await createLimitsReport(api)}` };
  }

  const usageLine = await readUsageHeader();
  const caption = `${usageLine}\nM:**—** (no LLM call)\n\n📊 ${reportTitle(api)} · infographic`;

  // Same channel adapter path as the built-in device-pair QR command.
  // Explicit local root ensures the generated image is allowed to be read.
  const to = ownerChatId(ctx);
  if (!to) {
    return { text: caption, mediaUrl: file };
  }
  try {
    const adapter = await api.runtime.channel.outbound.loadAdapter("telegram");
    if (adapter?.sendMedia) {
      await adapter.sendMedia({
        cfg: api.config,
        to,
        text: caption,
        mediaUrl: file,
        mediaLocalRoots: [IMAGE_DIR],
        ...(ctx.accountId ? { accountId: ctx.accountId } : {}),
      });
      return { suppressReply: true };
    }
  } catch (error) {
    api.logger.warn?.(`limits PNG delivery failed: ${error?.message ?? error}`);
    return { text: "⚠️ Could not send the image to Telegram.\n\n" + await createLimitsReport(api) };
  }
  // SDK fallback when the adapter has no direct media sender.
  return { text: caption, mediaUrl: file };
}

function isDirectOwnerCommand(ctx, ownerTelegramId) {
  const from = String(ctx.from ?? "").trim();
  const sessionKey = String(ctx.sessionKey ?? "").trim();
  const isGroup = from.startsWith("telegram:group:") ||
    sessionKey.includes(":telegram:group:");
  const isDirect = /^telegram:\d+$/.test(from) ||
    sessionKey.includes(":telegram:direct:");
  // Telegram may supply the sender as either a numeric id or telegram:<id>.
  const senderIdRaw = String(ctx.senderId ?? "").trim();
  const senderId = /^telegram:(\d+)$/.exec(senderIdRaw)?.[1] ?? senderIdRaw;

  return ctx.channel === "telegram" &&
    ctx.isAuthorizedSender === true &&
    ctx.messageThreadId == null &&
    !isGroup && isDirect &&
    /^\d+$/.test(ownerTelegramId) &&
    senderId === ownerTelegramId;
}

function stripOldHeader(text) {
  return text.replace(
    /^\s*W:[^\n]*\nM:[^\n]*(?:\n\s*)?/u,
    "",
  );
}

function resolveActualModel(event, runId) {
  const usage = event.usageState;

  if (typeof usage?.resolvedRef === "string" && usage.resolvedRef) {
    return usage.resolvedRef;
  }

  if (
    typeof usage?.provider === "string" &&
    usage.provider &&
    typeof usage?.model === "string" &&
    usage.model
  ) {
    return `${usage.provider}/${usage.model}`;
  }

  const remembered = runId
    ? modelByRun.get(runId)
    : undefined;

  if (remembered) {
    return `${remembered.provider}/${remembered.model}`;
  }

  if (typeof usage?.requested === "string" && usage.requested) {
    return usage.requested;
  }

  return "?";
}


// Accept a model label only from runtime observations of this session.
// The outbound message_sending hook lacks runId on some paths, so a bounded
// observation from llm_output is the closest available reliable evidence.
function resolveSessionModel(ctx, event) {
  const sessionKey = ctx?.sessionKey;
  const runId = ctx?.runId;
  let matches = [];
  if (typeof sessionKey === "string" && sessionKey) {
    const observed = modelBySession.get(sessionKey);
    if (observed) matches = [observed];
  } else {
    // Telegram's native outbound adapter sometimes omits the session key.
    // Match its exact chat/thread target; refuse ambiguous agent matches.
    const chat = String(ctx?.conversationId ?? event?.to ?? "");
    const thread = event?.threadId;
    const suffix = /^\d+$/.test(chat)
      ? `:telegram:direct:${chat}`
      : /^-\d+$/.test(chat)
        ? `:telegram:group:${chat}${thread != null ? `:topic:${thread}` : ""}`
        : null;
    if (suffix) {
      matches = [...modelBySession.entries()]
        .filter(([key]) => key.endsWith(suffix))
        .map(([, value]) => value);
    }
  }
  const recent = matches.filter((entry) =>
    Date.now() - entry.ts >= 0 &&
    Date.now() - entry.ts <= 45_000 &&
    (!runId || !entry.runId || entry.runId === runId)
  );
  return recent.length === 1 ? recent[0].ref : "?";
}

function alreadyHasUsageHeader(text) {
  return /^\s*W:[^\n]*\nM:/u.test(text);
}

export default definePluginEntry({
  id: "telegram-response-header",
  name: "Telegram Response Header",
  description: "Adds deterministic W/M headers to final Telegram agent replies.",

  register(api) {
    api.registerCommand({
      name: "limits",
      description: "OpenAI usage limits and subscriptions",
      channels: ["telegram"],
      requireAuth: true,
      acceptsArgs: false,
      handler: async (ctx) => {
        const ownerTelegramId = String(api.pluginConfig?.ownerTelegramId ?? "").trim();
        if (!isDirectOwnerCommand(ctx, ownerTelegramId)) {
          return { text: "⛔ /limits is available only to the authorized owner in a private chat. Configure ownerTelegramId." };
        }
        return await deliverLimitsImage(api, ctx);
      },
    });

    // A model call can stream its Telegram reply before llm_output fires.
    // llm_input is emitted at turn/start and records the attempted model; a
    // subsequent fallback attempt overwrites the same session's observation.
    // Only metadata is retained, never the prompt or conversation history.
    api.on("llm_input", (event, ctx) => {
      const key = ctx?.sessionKey;
      if (
        typeof key === "string" && key &&
        typeof event.provider === "string" && event.provider &&
        typeof event.model === "string" && event.model
      ) {
        modelBySession.set(key, {
          ref: `${event.provider}/${event.model}`,
          runId: event.runId,
          ts: Date.now(),
        });
      }
      cleanupMaps();
    });

    // Once the model call completes, its resolved runtime reference takes
    // precedence over the model selected at the start of the attempt.
    // Optional factual model observation from the Codex/embedded harness.
    // OpenClaw requires explicit hooks.allowConversationAccess=true for this
    // hook; the plugin discards all prompt, history and assistant text fields.
    api.on("llm_output", (event, ctx) => {
      const key = ctx?.sessionKey;
      const ref = typeof event.resolvedRef === "string" && event.resolvedRef
        ? event.resolvedRef
        : event.provider && event.model
          ? `${event.provider}/${event.model}`
          : undefined;
      if (typeof key === "string" && key && ref) {
        modelBySession.set(key, {
          ref,
          runId: event.runId,
          ts: Date.now(),
        });
      }
      cleanupMaps();
    });

    // The final-delivery fallback must cover Telegram's provider-owned route.
    api.on("message_sending", async (event, ctx) => {
      const channel = ctx?.channelId ?? event.metadata?.channel;
      if (channel !== "telegram" || typeof event.content !== "string") return;
      const content = event.content;
      if (!content.trim() || alreadyHasUsageHeader(content)) return;
      // Provider status/fallback notices are not model-generated answers.
      if (/^\s*↪️\s*Model Fallback/u.test(content)) return;
      const model = resolveSessionModel(ctx, event);
      return { content: `${await readUsageHeader()}\nM:**${model}**\n\n${stripOldHeader(content).trimStart()}` };
    });

    // The first streamed Telegram block may be delivered before the
    // model_call_ended hook fires. Capture the active model early; the latest
    // model_call_started event wins if the runtime falls back.
    api.on("model_call_started", (event) => {
      if (event.runId && event.provider && event.model) {
        modelByRun.set(event.runId, {
          provider: event.provider,
          model: event.model,
          ts: Date.now(),
        });
      }
      cleanupMaps();
    });

    api.on("model_call_ended", (event) => {
      if (
        event.outcome === "completed" &&
        event.runId &&
        event.provider &&
        event.model
      ) {
        modelByRun.set(event.runId, {
          provider: event.provider,
          model: event.model,
          ts: Date.now(),
        });
      }

      cleanupMaps();
    });

    api.on("reply_payload_sending", async (event, ctx) => {
      const channel = event.channel ?? ctx?.channelId;
      if (channel !== "telegram") {
        return;
      }

      // OpenClaw 2026.10.x can deliver the only visible reply as a
      // streaming "block". Waiting exclusively for "final" omits W/M
      // headers from those Telegram replies, especially in direct chats.
      if (event.kind !== "final" && event.kind !== "block") {
        return;
      }

      if (
        typeof event.payload?.text !== "string" ||
        !event.payload.text.trim()
      ) {
        return;
      }

      // Avoid prefixing stream/status lanes that are not an answer.
      if (
        event.payload.isReasoning === true ||
        event.payload.isCommentary === true ||
        event.payload.isStatusNotice === true ||
        event.payload.isCompactionNotice === true ||
        event.payload.isFallbackNotice === true
      ) {
        return;
      }

      // This command produces its own truthful header without invoking an LLM.
      // Do not replace M:— with a fabricated model label.
      if (/^W:[^\n]*\nM:[^\n]*\n\n📊 /u.test(event.payload.text)) {
        return;
      }

      // OpenClaw 2026.10.x may omit runId for some inbound/durable
      // delivery paths. Do not suppress the header in that case.
      const runId = event.runId || ctx?.runId;
      cleanupMaps();

      if (runId && prefixedRuns.has(runId)) {
        return;
      }

      const usageHeader = await readUsageHeader();
      const model = resolveActualModel(event, runId);
      const modelHeader = `M:**${model}**`;

      const body = stripOldHeader(event.payload.text).trimStart();

      // Dedupe only when correlation is known. Do not memoize a
      // session key as a run id: it would suppress future replies.
      if (runId) {
        prefixedRuns.set(runId, Date.now());
      }

      return {
        payload: {
          ...event.payload,
          text: `${usageHeader}\n${modelHeader}\n\n${body}`,
        },
      };
    });
  },
});
