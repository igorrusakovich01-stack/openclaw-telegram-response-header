import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";
import { promisify } from "node:util";
import {
  createReplyAudienceTracker,
  stripAnswerHeader,
  compactModelLine,
} from "../plugin/reply-audience.mjs";

const OWNER = "111111111";
const OTHER = "222222222";
const SESSION = "agent:main:telegram:group:-100123:topic:17";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(path.join(root, "plugin/index.js"), "utf8");

function harness() {
  // Evaluate the real plugin body against a minimal OpenClaw event mock.
  // Never connect to a real Gateway, Telegram, files or OAuth profiles.
  const body = source.slice(source.indexOf("const CACHE_FILE = path.join("))
    .replace("export default definePluginEntry(", "globalThis.pluginEntry = definePluginEntry(");
  const fakeCache = JSON.stringify({
    complete: true,
    header: "W:**73%** [synthetic]",
    cacheGeneratedAt: Date.now(),
  });
  const context = {
    process: { env: {} },
    os,
    path,
    promisify,
    execFile: (_file, _args, _opts, callback) => callback(null, "", ""),
    randomUUID: () => "synthetic",
    readFile: async () => fakeCache,
    mkdir: async () => {},
    readdir: async () => [],
    stat: async () => ({ mtimeMs: Date.now() }),
    unlink: async () => {},
    definePluginEntry: (entry) => entry,
    createReplyAudienceTracker,
    stripAnswerHeader,
    compactModelLine,
    Date,
    Intl,
  };
  vm.runInNewContext(body, context, { timeout: 2000 });
  const hooks = new Map();
  const api = {
    pluginConfig: { ownerTelegramId: OWNER },
    on(name, fn) {
      assert.equal(hooks.has(name), false, "Duplicate hook: " + name);
      hooks.set(name, fn);
    },
    registerCommand() {},
  };
  context.pluginEntry.register(api);
  return {
    api,
    on: (name, event, ctx) => {
      assert.ok(hooks.has(name), "Missing hook: " + name);
      return hooks.get(name)(event, ctx);
    },
  };
}

function input(sender, id, sessionKey = SESSION) {
  return {
    event: { channel: "telegram", senderId: sender, runId: id, messageId: id + "-msg" },
    ctx: { channelId: "telegram", senderId: sender, runId: id, messageId: id + "-msg", sessionKey },
  };
}

async function incoming(h, sender, id) {
  const { event, ctx } = input(sender, id);
  await h.on("message_received", event, ctx);
}

test("reply_payload_sending: owner has W/M, other has M only", async () => {
  const h = harness();
  await incoming(h, OWNER, "r-owner");
  await incoming(h, OTHER, "r-other");
  const event = (runId) => ({
    kind: "final",
    channel: "telegram",
    runId,
    usageState: { resolvedRef: "openai/demo-model" },
    payload: { text: "Answer" },
  });
  const owner = await h.on("reply_payload_sending", event("r-owner"), {
    channelId: "telegram", runId: "r-owner", sessionKey: SESSION,
  });
  const other = await h.on("reply_payload_sending", event("r-other"), {
    channelId: "telegram", runId: "r-other", sessionKey: SESSION,
  });
  assert.match(owner.payload.text, /^W:\*\*73%\*\*.*\nM:\*\*openai\/demo-model\*\*/);
  // The actual observed model must retain the documented update timestamp.
  assert.match(owner.payload.text, /M:\*\*openai\/demo-model\*\* upd \d{2}\.\d{2} \d{2}:\d{2}/);
  assert.match(other.payload.text, /M:\*\*openai\/demo-model\*\* upd \d{2}\.\d{2} \d{2}:\d{2}/);
  assert.match(other.payload.text, /^M:\*\*openai\/demo-model\*\*/);
  assert.doesNotMatch(other.payload.text, /W:/);
});

test("version 6.2 is explicit for observed model and no version is invented for aliases", async () => {
  const h = harness();
  await incoming(h, OWNER, "v-owner");
  await incoming(h, OTHER, "v-other");

  const owner = await h.on("reply_payload_sending", {
    kind: "final", channel: "telegram", runId: "v-owner",
    usageState: { resolvedRef: "openai/gpt-6.2-sol" },
    payload: { text: "Versioned answer" },
  }, { channelId: "telegram", sessionKey: SESSION, runId: "v-owner" });

  assert.match(owner.payload.text, /^W:/);
  assert.match(owner.payload.text,
    /M:\*\*openai\/gpt-6\.2-sol\*\* · v6\.2 upd \d{2}\.\d{2} \d{2}:\d{2}/);

  const other = await h.on("reply_payload_sending", {
    kind: "final", channel: "telegram", runId: "v-other",
    usageState: { resolvedRef: "openai/model-alias" },
    payload: { text: "Unversioned answer" },
  }, { channelId: "telegram", sessionKey: SESSION, runId: "v-other" });

  assert.match(other.payload.text, /^M:\*\*openai\/model-alias\*\* upd /);
  assert.doesNotMatch(other.payload.text, / · v\d/);
  assert.doesNotMatch(other.payload.text, /^W:/);
});

test("version 6.2 is explicit in native message_sending model observations", async () => {
  const h = harness();
  await incoming(h, OTHER, "v-message");
  await h.on("llm_input", {
    provider: "openai", model: "gpt-6.2-sol", runId: "v-message",
  }, { sessionKey: SESSION });

  const result = await h.on("message_sending", {
    metadata: { channel: "telegram" }, content: "Hello",
  }, { channelId: "telegram", runId: "v-message", sessionKey: SESSION });

  assert.match(result.content,
    /^M:\*\*openai\/gpt-6\.2-sol\*\* · v6\.2 upd /);
  assert.doesNotMatch(result.content, /^W:/);
});

test("message_sending: owner has W/M, other M-only, unknown strips old W", async () => {
  const h = harness();
  await incoming(h, OWNER, "a-owner");
  await incoming(h, OTHER, "a-other");
  const event = (text) => ({
    metadata: { channel: "telegram" },
    content: text,
  });
  const owner = await h.on("message_sending", event("Owner answer"), {
    channelId: "telegram", runId: "a-owner", sessionKey: SESSION,
  });
  const other = await h.on("message_sending", event("Other answer"), {
    channelId: "telegram", runId: "a-other", sessionKey: SESSION,
  });
  const unknown = await h.on("message_sending",
    event("W:old\nM:**openai/demo-model**\n\nUnknown answer"),
    { channelId: "telegram", sessionKey: SESSION });
  assert.match(owner.content, /^W:\*\*73%\*\*/);
  assert.match(other.content, /^M:/);
  assert.doesNotMatch(other.content, /W:/);
  assert.equal(unknown.content, "M:**openai/demo-model**\n\nUnknown answer");
});

test("status and reasoning payloads bypass the header hook", async () => {
  const h = harness();
  const result = await h.on("reply_payload_sending", {
    channel: "telegram",
    kind: "block",
    payload: { text: "status", isStatusNotice: true },
  }, { channelId: "telegram" });
  assert.equal(result, undefined);
});

test("report-shaped replies from unknown or other senders never bypass W privacy", async () => {
  const h = harness();
  await incoming(h, OTHER, "r-report-other");
  const report = "W:**12%** [synthetic]\nM:**—**\n\n📊 Usage data";

  const normalUnknown = await h.on("message_sending", {
    metadata: { channel: "telegram" }, content: report,
  }, { channelId: "telegram", sessionKey: SESSION });
  assert.ok(normalUnknown);
  assert.equal(normalUnknown.content, "M:**—**\n\n📊 Usage data");

  const normalOther = await h.on("message_sending", {
    metadata: { channel: "telegram" }, content: report,
  }, { channelId: "telegram", runId: "r-report-other", sessionKey: SESSION });
  assert.ok(normalOther);
  assert.doesNotMatch(normalOther.content, /^W:/);

  const deliveryOther = await h.on("reply_payload_sending", {
    channel: "telegram",
    kind: "final",
    runId: "r-report-other",
    payload: { text: report },
  }, { channelId: "telegram", runId: "r-report-other", sessionKey: SESSION });
  assert.ok(deliveryOther);
  assert.equal(deliveryOther.payload.text, "M:**—**\n\n📊 Usage data");
});

test("explicit authenticated owner /limits report retains its command header", async () => {
  const h = harness();
  const report = "W:**73%** [synthetic]\nM:**—**\n\n📊 Usage data";
  const directOwner = {
    channel: "telegram",
    channelId: "telegram",
    senderId: OWNER,
    from: "telegram:" + OWNER,
    sessionKey: "agent:main:telegram:direct:" + OWNER,
    messageThreadId: null,
    isAuthorizedSender: true,
  };

  const normal = await h.on("message_sending", {
    metadata: { channel: "telegram" }, content: report,
  }, directOwner);
  assert.equal(normal, undefined);

  const delivery = await h.on("reply_payload_sending", {
    channel: "telegram", kind: "final",
    payload: { text: report },
  }, directOwner);
  assert.equal(delivery, undefined);
});
