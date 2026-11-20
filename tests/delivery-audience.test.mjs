import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import {
  DEFAULT_LINES, NO_LINES, createTopicHeaderStore,
  parseHeaderAction, topicForCommand, topicForReply,
} from "../plugin/topic-header-settings.mjs";
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
  const fakeHome = mkdtempSync(path.join(os.tmpdir(), "header-delivery-test-"));
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
    os: { homedir: () => fakeHome },
    path,
    DEFAULT_LINES, NO_LINES, createTopicHeaderStore,
    parseHeaderAction, topicForCommand, topicForReply,
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
  const commands = new Map();
  const api = {
    pluginConfig: { ownerTelegramId: OWNER },
    on(name, fn) {
      assert.equal(hooks.has(name), false, "Duplicate hook: " + name);
      hooks.set(name, fn);
    },
    registerCommand(command) { commands.set(command.name, command); },
  };
  context.pluginEntry.register(api);
  return {
    api,
    on: (name, event, ctx) => {
      assert.ok(hooks.has(name), "Missing hook: " + name);
      return hooks.get(name)(event, ctx);
    },
    command: (name, ctx) => {
      assert.ok(commands.has(name), "Missing slash command: " + name);
      return commands.get(name).handler(ctx);
    },
  };
}

function ownerTopicCommand(args = "", sender = OWNER) {
  return {
    channel: "telegram", isAuthorizedSender: true, senderId: sender,
    from: "telegram:group:-100123", messageThreadId: 17,
    sessionKey: SESSION, args,
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
  await h.command("header", ownerTopicCommand("w on"));
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
  await h.command("header", ownerTopicCommand("w on"));
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
  await h.command("header", ownerTopicCommand("w on"));
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

test("default W off, M on; only owner can change this topic", async () => {
  const h = harness();
  const original = await h.command("header", ownerTopicCommand());
  assert.match(original.text, /W off, M on/);
  const stranger = await h.command("header", ownerTopicCommand("w on", OTHER));
  assert.match(stranger.text, /only by the configured Telegram owner/);
  const untrusted = await h.command("header", {
    ...ownerTopicCommand("w on"), isAuthorizedSender: false,
  });
  assert.match(untrusted.text, /only by the configured Telegram owner/);
  const contradictory = await h.command("header", {
    ...ownerTopicCommand("w on"), messageThreadId: 19,
  });
  assert.match(contradictory.text, /recognized Telegram forum topic/);
  assert.match((await h.command("header", ownerTopicCommand())).text, /W off, M on/);

  await incoming(h, OWNER, "default-owner");
  const result = await h.on("reply_payload_sending", {
    channel: "telegram", kind: "final", runId: "default-owner",
    usageState: { resolvedRef: "openai/gpt-6.2-sol" },
    payload: { text: "Hello" },
  }, { channelId: "telegram", sessionKey: SESSION, runId: "default-owner" });
  assert.match(result.payload.text, /^M:\*\*openai\/gpt-6\.2-sol\*\* · v6\.2/);
  assert.doesNotMatch(result.payload.text, /W:/);
});

test("per-topic /header controls W and M independently, reset restores defaults", async () => {
  const h = harness();
  const topic18 = SESSION.replace(":topic:17", ":topic:18");
  assert.match((await h.command("header", ownerTopicCommand("m off"))).text, /W off, M off/);
  await incoming(h, OWNER, "disabled-owner");
  const disabled = await h.on("reply_payload_sending", {
    channel: "telegram", kind: "final", runId: "disabled-owner",
    usageState: { resolvedRef: "openai/gpt-6.2-sol" },
    payload: { text: "W:**12%**\nM:**old**\n\nReal body" },
  }, { channelId: "telegram", runId: "disabled-owner", sessionKey: SESSION });
  assert.equal(disabled.payload.text, "Real body");

  await incoming(h, OTHER, "topic18");
  const otherTopic = await h.on("reply_payload_sending", {
    channel: "telegram", kind: "final", runId: "topic18",
    usageState: { resolvedRef: "openai/gpt-6.2-sol" },
    payload: { text: "Different topic" },
  }, { channelId: "telegram", runId: "topic18", sessionKey: topic18 });
  assert.match(otherTopic.payload.text, /^M:/);

  await h.command("header", ownerTopicCommand("w on"));
  assert.match((await h.command("header", ownerTopicCommand())).text, /W on, M off/);
  await incoming(h, OWNER, "w-only");
  const wOnly = await h.on("reply_payload_sending", {
    channel: "telegram", kind: "final", runId: "w-only",
    payload: { text: "Quota only" },
  }, { channelId: "telegram", sessionKey: SESSION, runId: "w-only" });
  assert.match(wOnly.payload.text, /^W:\*\*73%\*\*/);
  assert.doesNotMatch(wOnly.payload.text, /M:/);

  await h.command("header", ownerTopicCommand("reset"));
  assert.match((await h.command("header", ownerTopicCommand())).text, /W off, M on/);
});

test("topic-off setting also suppresses message_sending headers across models", async () => {
  const h = harness();
  await h.command("header", ownerTopicCommand("off"));
  await incoming(h, OWNER, "off-run");
  const result = await h.on("message_sending", {
    metadata: { channel: "telegram" },
    content: "W:**12%**\nM:**old**\n\nJust answer",
  }, { channelId: "telegram", runId: "off-run",
       sessionKey: "agent:other-model:telegram:group:-100123:topic:17" });
  assert.equal(result.content, "Just answer");
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
