import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  createReplyAudienceTracker,
  stripAnswerHeader,
  compactModelLine,
} from "./reply-audience.mjs";
import {
  DEFAULT_LINES, NO_LINES, createTopicHeaderStore,
  parseHeaderAction, topicForCommand, topicForReply,
} from "./topic-header-settings.mjs";

const CACHE_FILE = path.join(
  os.homedir(),
  ".openclaw",
  "workspace",
  "codex-usage-current.json",
);

const HEADER_TOPICS_FILE = path.join(os.homedir(), ".openclaw", "telegram-response-header-topics.json");
const RENDERER = path.join(os.homedir(), ".openclaw", "workspace", "tools", "render-limits-png");
const ANALYTICS_RENDERER = path.join(os.homedir(), ".openclaw", "workspace", "tools", "render-limits-analytics");
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
  for (const zone of [api?.pluginConfig?.timeZone, process.env.OPENCLAW_USAGE_TIMEZONE, Intl.DateTimeFormat().resolvedOptions().timeZone, "UTC"]) {
    if (typeof zone !== "string" || !zone.trim()) continue;
    try {
      new Intl.DateTimeFormat("en", { timeZone: zone.trim() });
      return zone.trim();
    } catch {
      // An invalid zone must not prevent replies or reports.
    }
  }
  return "UTC";
}

function formatLocalTime(date = new Date(), api) {
  const zone = configuredTimeZone(api);
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone, day: "2-digit", month: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(date);
  } catch {
    parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "UTC", day: "2-digit", month: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(date);
  }
  const fields = Object.fromEntries(
    parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value])
  );
  return `${fields.day}.${fields.month} ${fields.hour}:${fields.minute}`;
}

// Expose a version only when the observed model ID states it explicitly.
// Avoid inventing versions for aliases or unrecognized providers.
function observedModelVersion(model) {
  const found = /(?:^|[/-])(?:gpt-|qwen|gemini-)(\d+(?:\.\d+)+)(?=$|[-/])/iu.exec(String(model));
  return found?.[1] ?? null;
}

function modelLineWithVersion(model, timestamp = true, api) {
  const version = observedModelVersion(model);
  const suffix = version ? ` · v${version}` : "";
  return `M:**${model}**${suffix}${timestamp ? ` upd ${formatLocalTime(new Date(), api)}` : ""}`;
}

function fallbackModelLineWithVersion(text) {
  const line = compactModelLine(text);
  const model = /^M:\*\*([^*\n]+)\*\*/u.exec(line)?.[1];
  return model ? modelLineWithVersion(model, false) : line;
}

function cachedHeaderInZone(data, api) {
  const header = data.header.trim();
  const stamp = Number(data.earliestResetAt);
  const reset = Number.isFinite(stamp) && stamp > 0 && Number.isFinite(new Date(stamp).getTime())
    ? formatLocalTime(new Date(stamp), api) : "?";
  return header.replace(/~(?:\d{2}\.\d{2} \d{2}:\d{2}|\?)(?=\s|$)/u, "~" + reset);
}

async function readUsageHeader(api) {
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
      return cachedHeaderInZone(data, api);
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
    data.complete === true && typeof data.header === "string" && fresh ? cachedHeaderInZone(data, api) :
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

  const usageLine = await readUsageHeader(api);
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

async function makeAnalyticsImages(api) {
  await mkdir(IMAGE_DIR, { recursive: true, mode: 0o700 });
  try {
    for (const entry of await readdir(IMAGE_DIR, { withFileTypes: true })) {
      if (!entry.isFile() || !/^limits-analytics-(?:groups|topics)-[a-f0-9-]{36}\.png$/u.test(entry.name)) continue;
      const existing = path.join(IMAGE_DIR, entry.name);
      if (Date.now() - (await stat(existing)).mtimeMs > 24 * 60 * 60 * 1000) await unlink(existing);
    }
  } catch {
    // Cleanup is best effort.
  }
  const id = randomUUID();
  const groups = path.join(IMAGE_DIR, "limits-analytics-groups-" + id + ".png");
  const topics = path.join(IMAGE_DIR, "limits-analytics-topics-" + id + ".png");
  await runFile("python3", [ANALYTICS_RENDERER, groups, topics, "--timezone", configuredTimeZone(api)], {
    timeout: 95_000,
    maxBuffer: 64 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  return { groups, topics };
}

const LIMITS_HELP = "Usage: /limits | /limits quota | /limits projects | /limits topics | /limits users";
const LIMITS_USERS = "Individual token attribution is unavailable for authors sharing one topic history. Use /limits projects or /limits topics for aggregate usage.";
let analyticsInProgress = false;

async function deliverLimitsWithAnalytics(api, ctx, mode) {
  if (mode === "users") return { text: LIMITS_USERS };
  if (mode === "quota") return deliverLimitsImage(api, ctx);
  if (analyticsInProgress) return { text: "Usage analytics is already running. Try again shortly." };
  analyticsInProgress = true;
  try {
    const original = mode === "all" ? await deliverLimitsImage(api, ctx) : null;
    // Preserve the quota fallback when direct media delivery is unavailable.
    if (original && original.suppressReply !== true) return original;
    const to = ownerChatId(ctx);
    if (!to) return { text: "Private report destination is unavailable." };
    let adapter;
    try {
      adapter = await api.runtime.channel.outbound.loadAdapter("telegram");
      if (!adapter?.sendMedia) return { text: "Analytics media delivery is unavailable." };
    } catch {
      return { text: "Analytics media delivery is unavailable." };
    }
    let images;
    try {
      images = await makeAnalyticsImages(api);
    } catch {
      // Do not log subprocess output: it may include private session data.
      api.logger?.warn?.("limits analytics unavailable");
      return { text: "Session analytics is unavailable. Try /limits projects or /limits topics later." };
    }
    const chosen = mode === "projects" ? [["groups", "Groups & Projects"]]
      : mode === "topics" ? [["topics", "Topics & Trends"]]
      : [["groups", "Groups & Projects"], ["topics", "Topics & Trends"]];
    const commandHeader = (await readUsageHeader(api)) + "\nM:**—** (no LLM call)\n\n";
    const failed = [];
    for (const [which, title] of chosen) {
      try {
        await adapter.sendMedia({
          cfg: api.config,
          to,
          text: commandHeader + "📊 " + title + " · today and retained history. Partial data is marked.",
          mediaUrl: images[which],
          mediaLocalRoots: [IMAGE_DIR],
          ...(ctx.accountId ? { accountId: ctx.accountId } : {}),
        });
      } catch {
        failed.push(title);
      }
    }
    if (failed.length) return { text: "Analytics delivery failed: " + failed.join(", ") + ". Try again later." };
    return { suppressReply: true };
  } finally {
    analyticsInProgress = false;
  }
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

// For /header, the Telegram adapter's sender and topic are the scope.
// Do not use OpenClaw's agent/owner allowlist: normal topic members may not
// have isAuthorizedSender=true. /limits keeps its separate owner-only check.
function isTopicHeaderParticipant(ctx) {
  const sender = String(ctx?.senderId ?? "").trim().replace(/^telegram:/u, "");
  return ctx?.channel === "telegram" &&
    /^[1-9][0-9]{0,18}$/u.test(sender) &&
    topicForCommand(ctx) !== null;
}

function formatTopicHeaderStatus(settings) {
  return "Header for this topic: W " + (settings.w ? "on" : "off") +
    ", M " + (settings.m ? "on" : "off") +
    "\nCommands: /header status | w on/off | m on/off | on | off | reset";
}

function isHeaderCommandReply(text) {
  const body = stripAnswerHeader(text).trim();
  return /^Header for this topic: W (?:on|off), M (?:on|off)\nCommands: \/header status \| w on\/off \| m on\/off \| on \| off \| reset$/u.test(body) ||
    ["Use /header from a Telegram user inside a recognized forum topic.",
     "Run /header inside a recognized Telegram forum topic.",
     "Usage: /header status | w on/off | m on/off | on | off | reset",
     "Header settings could not be read or saved. No change was confirmed.",
     "⚠️ This command is no longer available after the plugin registry changed. Please try again.",
     "⚠️ This command selection is no longer valid. Please try again.",
     LIMITS_HELP, LIMITS_USERS, "Usage analytics is already running. Try again shortly.",
     "Private report destination is unavailable.", "Analytics media delivery is unavailable.",
     "Session analytics is unavailable. Try /limits projects or /limits topics later.",
     "⛔ /limits is available only to the authorized owner in a private chat. Configure ownerTelegramId."].includes(body) ||
    /^Analytics delivery failed: (?:Groups & Projects|Topics & Trends)(?:, Topics & Trends)?\. Try again later\.$/u.test(body);
}

async function renderTopicReplyHeader({ api, event, ctx, store, modelLine }) {
  const scope = topicForReply(event, ctx);
  let settings;
  if (scope) {
    try {
      settings = await store.read(scope);
    } catch {
      // A broken preference file must not disclose quota or bypass a topic-off rule.
      settings = NO_LINES;
    }
  } else {
    // Unknown topic routes must not inherit another topic's preferences.
    const session = String(ctx?.sessionKey ?? event?.sessionKey ?? "");
    settings = /:telegram:direct:[0-9]+$/u.test(session) ? DEFAULT_LINES : NO_LINES;
  }
  const lines = [];
  // W is a shared, opt-in topic display, not a per-sender entitlement.
  if (scope && settings.w) lines.push(await readUsageHeader(api));
  if (settings.m) lines.push(modelLine());
  return lines.join("\n");
}

export default definePluginEntry({
  id: "telegram-response-header",
  name: "Telegram Response Header",
  description: "Adds deterministic W/M headers to final Telegram agent replies.",

  register(api) {
    // Metadata-only correlation; never infer the sender from the last
    // message in a shared Telegram group or topic.
    const replyAudience = createReplyAudienceTracker();
    const topicHeaderStore = createTopicHeaderStore(HEADER_TOPICS_FILE);
    api.on("message_received", (event, ctx) => replyAudience.remember(event, ctx));
    api.on("before_dispatch", (event, ctx) => replyAudience.remember(event, ctx));

    api.registerCommand({
      name: "limits",
      description: "Private OpenAI quota and session usage reports",
      channels: ["telegram"],
      requireAuth: true,
      acceptsArgs: true,
      handler: async (ctx) => {
        const ownerTelegramId = String(api.pluginConfig?.ownerTelegramId ?? "").trim();
        if (!isDirectOwnerCommand(ctx, ownerTelegramId)) {
          return { text: "⛔ /limits is available only to the authorized owner in a private chat. Configure ownerTelegramId." };
        }
        const mode = String(ctx.args ?? "").trim().toLowerCase() || "all";
        if (!["all", "quota", "projects", "topics", "users"].includes(mode)) return { text: LIMITS_HELP };
        return await deliverLimitsWithAnalytics(api, ctx, mode);
      },
    });

    api.registerCommand({
      name: "header",
      description: "Let any Telegram forum topic participant configure W/M lines",
      channels: ["telegram"],
      requireAuth: false,
      acceptsArgs: true,
      handler: async (ctx) => {
        // The message must originate from a Telegram group topic with an
        // identifiable sender, even when the sender is not an OpenClaw owner.
        if (!isTopicHeaderParticipant(ctx)) {
          return { text: "Use /header from a Telegram user inside a recognized forum topic." };
        }
        const scope = topicForCommand(ctx);
        if (!scope) {
          return { text: "Run /header inside a recognized Telegram forum topic." };
        }
        const action = parseHeaderAction(ctx.args);
        if (!action) {
          return { text: "Usage: /header status | w on/off | m on/off | on | off | reset" };
        }
        try {
          const settings = action.type === "status"
            ? await topicHeaderStore.read(scope)
            : await topicHeaderStore.change(scope, action);
          return { text: formatTopicHeaderStatus(settings) };
        } catch {
          api.logger?.warn?.("Telegram header topic settings are unavailable");
          return { text: "Header settings could not be read or saved. No change was confirmed." };
        }
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
      const channel = event?.metadata?.channel ?? event?.channel ??
        ctx?.messageProvider ?? ctx?.channel ?? ctx?.channelId;
      if (channel !== "telegram" || typeof event.content !== "string") return;
      const content = event.content;
      if (!content.trim()) return;
      if (isHeaderCommandReply(content)) {
        const body = stripAnswerHeader(content).trimStart();
        return body === content ? undefined : { content: body };
      }
      const owner = replyAudience.isOwnerReply(event, ctx, api.pluginConfig?.ownerTelegramId);
      const authenticatedOwnerCommand = Boolean(ctx) &&
        isDirectOwnerCommand(ctx, String(api.pluginConfig?.ownerTelegramId ?? "").trim());
      // A report-shaped body alone is not proof of authorization.
      if ((owner || authenticatedOwnerCommand) &&
        /^\s*W:[^\n]*\nM:[^\n]*\n\n📊/u.test(content)) return;
      // Provider status/fallback notices are not model-generated answers.
      if (/^\s*↪️\s*Model Fallback/u.test(content)) return;
      const header = await renderTopicReplyHeader({
        api, event, ctx, store: topicHeaderStore,
        modelLine: () => {
          const observed = resolveSessionModel(ctx, event);
          return observed !== "?" ? modelLineWithVersion(observed, true, api)
            : fallbackModelLineWithVersion(content);
        },
      });
      const body = stripAnswerHeader(content).trimStart();
      const finalText = header ? header + "\n\n" + body : body;
      return finalText === content ? undefined : { content: finalText };
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
      const channel = event.channel ?? ctx?.messageProvider ?? ctx?.channel ?? ctx?.channelId;
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

      if (isHeaderCommandReply(event.payload.text)) {
        const body = stripAnswerHeader(event.payload.text).trimStart();
        return body === event.payload.text ? undefined : { payload: { ...event.payload, text: body } };
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

      const owner = replyAudience.isOwnerReply(event, ctx, api.pluginConfig?.ownerTelegramId);
      const authenticatedOwnerCommand = Boolean(ctx) &&
        isDirectOwnerCommand(ctx, String(api.pluginConfig?.ownerTelegramId ?? "").trim());
      // Only an authenticated owner command may retain its own W/M header.
      // A report-shaped body without owner evidence must be sanitized.
      if ((owner || authenticatedOwnerCommand) &&
        /^W:[^\n]*\nM:[^\n]*\n\n📊 /u.test(event.payload.text)) {
        return;
      }

      // OpenClaw 2026.10.x may omit runId for some inbound/durable
      // delivery paths. Do not suppress the header in that case.
      const runId = event.runId || ctx?.runId;
      cleanupMaps();

      if (runId && prefixedRuns.has(runId)) {
        return;
      }

      const header = await renderTopicReplyHeader({
        api, event, ctx, store: topicHeaderStore,
        modelLine: () => {
          const model = resolveActualModel(event, runId);
          return model !== "?" ? modelLineWithVersion(model, true, api)
            : fallbackModelLineWithVersion(event.payload.text);
        },
      });

      const body = stripAnswerHeader(event.payload.text).trimStart();
      const finalText = header ? header + "\n\n" + body : body;
      if (finalText === event.payload.text) return;

      // Dedupe only when correlation is known. Do not memoize a
      // session key as a run id: it would suppress future replies.
      if (runId) {
        prefixedRuns.set(runId, Date.now());
      }

      return {
        payload: {
          ...event.payload,
          text: finalText,
        },
      };
    });
  },
});
