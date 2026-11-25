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

function harness(options = {}) {
  // Evaluate the real plugin body against a minimal OpenClaw event mock.
  const fakeHome = mkdtempSync(path.join(os.tmpdir(), "header-delivery-test-"));
  // Never connect to a real Gateway, Telegram, files or OAuth profiles.
  const body = source.slice(source.indexOf("const CACHE_FILE = path.join("))
    .replace("export default definePluginEntry(", "globalThis.pluginEntry = definePluginEntry(");
  const fakeCache = JSON.stringify({
    complete: true,
    header: "W:**73%** [synthetic]",
    cacheGeneratedAt: Date.now(),
    ...options.cache,
  });
  const sent = [], executions = [];
  const context = {
    process: { env: options.env || {} },
    os: { homedir: () => fakeHome },
    path,
    DEFAULT_LINES, NO_LINES, createTopicHeaderStore,
    parseHeaderAction, topicForCommand, topicForReply,
    promisify,
    execFile: (_file, args, _opts, callback) => {
      executions.push([...args]);
      if (options.failAnalytics && args[0].endsWith("render-limits-analytics")) callback(new Error("synthetic renderer failure"));
      else callback(null, "", "");
    },
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
    pluginConfig: { ownerTelegramId: OWNER, ...options.pluginConfig },
    logger: { warn() {} },
    runtime: { channel: { outbound: { loadAdapter: async () => ({ sendMedia: async (params) => {
      if (options.failDelivery && params.mediaUrl.includes(options.failDelivery)) throw new Error("synthetic delivery failure");
      sent.push(params);
    } }) } } },
    on(name, fn) {
      assert.equal(hooks.has(name), false, "Duplicate hook: " + name);
      hooks.set(name, fn);
    },
    registerCommand(command) { commands.set(command.name, command); },
  };
  context.pluginEntry.register(api);
  return {
    api, sent, executions,
    on: (name, event, ctx) => {
      assert.ok(hooks.has(name), "Missing hook: " + name);
      return hooks.get(name)(event, ctx);
    },
    command: (name, ctx) => {
      assert.ok(commands.has(name), "Missing slash command: " + name);
      return commands.get(name).handler(ctx);
    },
    commandRegistration: (name) => commands.get(name),
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

test("reply_payload_sending: W/M are shared across participants", async () => {
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
  assert.match(other.payload.text, /^W:\*\*73%\*\*/);
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

  assert.match(other.payload.text, /\nM:\*\*openai\/model-alias\*\* upd /);
  assert.doesNotMatch(other.payload.text, / · v\d/);
  assert.match(other.payload.text, /^W:/);
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

test("message_sending: W is shared, stale W is replaced even without sender metadata", async () => {
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
  assert.match(other.content, /^W:\*\*73%\*\*/);
  assert.equal(unknown.content, "W:**73%** [synthetic]\nM:**openai/demo-model**\n\nUnknown answer");
});

test("default W off, M on; any topic participant can change, but unknown origins cannot", async () => {
  const h = harness();
  assert.equal(h.commandRegistration("header").requireAuth, false);
  assert.equal(h.commandRegistration("limits").requireAuth, true);
  const original = await h.command("header", ownerTopicCommand());
  assert.match(original.text, /W off, M on/);

  const member = await h.command("header", {
    ...ownerTopicCommand("m off", OTHER), isAuthorizedSender: false,
  });
  assert.match(member.text, /W off, M off/);
  // An ordinary participant can change the same topic again.
  assert.match((await h.command("header", {
    ...ownerTopicCommand("m on", OTHER), isAuthorizedSender: false,
  })).text, /W off, M on/);

  const anonymous = await h.command("header", {
    ...ownerTopicCommand("w on"), senderId: null, isAuthorizedSender: false,
  });
  assert.match(anonymous.text, /Use \/header from a Telegram user/);
  const forged = await h.command("header", {
    ...ownerTopicCommand("w on"), senderId: "telegram:group:-100123",
  });
  assert.match(forged.text, /Use \/header from a Telegram user/);
  const fromDirect = await h.command("header", {
    ...ownerTopicCommand("w on", OTHER),
    sessionKey: "agent:main:telegram:direct:222222222",
  });
  assert.match(fromDirect.text, /Use \/header from a Telegram user/);
  const contradictory = await h.command("header", {
    ...ownerTopicCommand("w on", OTHER), messageThreadId: 19,
  });
  assert.match(contradictory.text, /Use \/header from a Telegram user/);
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

test("ordinary participant may enable W for every reply", async () => {
  const h = harness();
  const changed = await h.command("header", {
    ...ownerTopicCommand("w on", OTHER), isAuthorizedSender: false,
  });
  assert.match(changed.text, /W on, M on/);

  await incoming(h, OTHER, "member-w");
  const member = await h.on("reply_payload_sending", {
    channel: "telegram", kind: "final", runId: "member-w",
    usageState: { resolvedRef: "openai/gpt-6.2-sol" },
    payload: { text: "Member response" },
  }, { channelId: "telegram", sessionKey: SESSION, runId: "member-w" });
  assert.match(member.payload.text, /^W:/);
  assert.match(member.payload.text, /\nM:/);

  await incoming(h, OWNER, "owner-w");
  const owner = await h.on("reply_payload_sending", {
    channel: "telegram", kind: "final", runId: "owner-w",
    usageState: { resolvedRef: "openai/gpt-6.2-sol" },
    payload: { text: "Owner response" },
  }, { channelId: "telegram", sessionKey: SESSION, runId: "owner-w" });
  assert.match(owner.payload.text, /^W:/);
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

test("numeric channelId target does not hide Telegram delivery", async () => {
  const h = harness();
  await incoming(h, OTHER, "numeric-channel");
  const result = await h.on("message_sending", {
    metadata: { channel: "telegram" },
    content: "Reply for topic",
  }, {
    channelId: "-100123", runId: "numeric-channel", sessionKey: SESSION,
  });
  assert.match(result.content, /^M:/);
  assert.doesNotMatch(result.content, /^W:/);
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


test("native delivery without sender or runId shares W across agents and keeps topics isolated", async () => {
  const h = harness();
  await h.command("header", {...ownerTopicCommand("w on", OTHER), isAuthorizedSender: false});
  const event = { metadata: { channel: "telegram" }, to: "-100123", threadId: 17, content: "Answer" };
  const r = await h.on("message_sending", event, { channelId: "telegram" });
  assert.match(r.content, /^W:\*\*73%\*\*/);
  const other = await h.on("message_sending", {...event, threadId: 18}, {channelId: "telegram"});
  assert.doesNotMatch(other.content, /^W:/);
  const conflict = await h.on("message_sending", {...event, threadId: 18, content: "W:old\nAnswer"}, {channelId:"telegram",sessionKey:SESSION});
  assert.equal(conflict.content, "Answer");
});
test("header command replies have no stale or unknown model on either delivery path", async () => {
  const h = harness();
  const response = await h.command("header", ownerTopicCommand("on", OTHER));
  await h.on("llm_input", {provider:"openai", model:"old-model", runId:"earlier"}, {sessionKey:SESSION});
  const ctx = {channelId:"telegram", sessionKey:SESSION};
  for (const text of [response.text, "M:**?**\n\n"+response.text, "M:**old-model**\n\n"+response.text]) {
    const native = await h.on("message_sending", {metadata:{channel:"telegram"},content:text},ctx);
    assert.equal(native?.content ?? text,response.text);
    const payload = await h.on("reply_payload_sending",{channel:"telegram",kind:"final",payload:{text}},ctx);
    assert.equal(payload?.payload.text ?? text,response.text);
  }
});
test("limits command denies all group participants including owner and non-owner direct callers", async () => {
  const h = harness();
  for (const ctx of [ownerTopicCommand("", OWNER),ownerTopicCommand("", OTHER),{channel:"telegram",senderId:OTHER,from:"telegram:"+OTHER,sessionKey:"agent:main:telegram:direct:"+OTHER,isAuthorizedSender:true}]) {
    assert.match((await h.command("limits",ctx)).text,/available only to the authorized owner/);
  }
});


function directLimits(args = "", sender = OWNER) {
  return { channel:"telegram", channelId:"telegram", senderId:sender, from:"telegram:"+sender,
    sessionKey:"agent:main:telegram:direct:"+sender, messageThreadId:null, isAuthorizedSender:true, args, accountId:"test-account" };
}

test("limits sends all three private PNGs, using configured timezone for both renderers", async () => {
  const h = harness({pluginConfig:{timeZone:"Asia/Tokyo"}, env:{OPENCLAW_USAGE_TIMEZONE:"UTC"},
    cache:{header:"W:**73%** [synthetic] ~01.01 00:00 🟢", earliestResetAt:Date.UTC(2027,0,1,0,0)}});
  assert.equal(h.commandRegistration("limits").acceptsArgs,true);
  assert.equal((await h.command("limits",directLimits())).suppressReply,true);
  assert.equal(h.sent.length,3);
  assert.ok(h.sent[0].mediaUrl.endsWith("limits-synthetic.png"));
  assert.ok(h.sent[1].mediaUrl.endsWith("limits-analytics-groups-synthetic.png"));
  assert.ok(h.sent[2].mediaUrl.endsWith("limits-analytics-topics-synthetic.png"));
  for (const item of h.sent) {
    assert.equal(item.to,OWNER);
    assert.equal(item.accountId,"test-account");
    assert.match(item.text, /~01\.01 09:00/);
    assert.match(item.text, /M:\*\*—\*\* \(no LLM call\)/);
  }
  assert.equal(h.executions.length,2);
  assert.equal(h.executions[0].at(-1),"Asia/Tokyo");
  assert.equal(h.executions[1].at(-1),"Asia/Tokyo");
});

test("limits modes select only the requested private image and users/help make no renderer calls", async () => {
  for (const [mode, suffix] of [["quota","limits-synthetic.png"],["projects","limits-analytics-groups-synthetic.png"],["topics","limits-analytics-topics-synthetic.png"]]) {
    const h = harness();
    assert.equal((await h.command("limits",directLimits(mode))).suppressReply,true);
    assert.equal(h.sent.length,1);
    assert.ok(h.sent[0].mediaUrl.endsWith(suffix));
    assert.equal(h.executions.length,1);
  }
  const h = harness();
  assert.match((await h.command("limits",directLimits("users"))).text,/Individual token attribution is unavailable/);
  assert.match((await h.command("limits",directLimits("invalid"))).text,/Usage: \/limits/);
  assert.equal(h.executions.length,0);
  assert.equal(h.sent.length,0);
});

test("every limits mode rejects non-owner and group callers before private rendering", async () => {
  const h = harness();
  for (const mode of ["","quota","projects","topics","users"]) {
    for (const ctx of [ownerTopicCommand(mode,OWNER),ownerTopicCommand(mode,OTHER),directLimits(mode,OTHER),{...directLimits(mode),isAuthorizedSender:false}]) {
      assert.match((await h.command("limits",ctx)).text,/available only to the authorized owner/);
    }
  }
  assert.equal(h.executions.length,0);
  assert.equal(h.sent.length,0);
});

test("quota remains delivered if analytics fails; selective media failure is reported", async () => {
  const failed = harness({failAnalytics:true});
  assert.match((await failed.command("limits",directLimits())).text,/Session analytics is unavailable/);
  assert.equal(failed.sent.length,1);
  const retry = await failed.command("limits",directLimits("topics"));
  assert.match(retry.text,/Session analytics is unavailable/);
  const partial = harness({failDelivery:"groups"});
  assert.match((await partial.command("limits",directLimits())).text,/Analytics delivery failed: Groups & Projects/);
  assert.equal(partial.sent.length,2);
  assert.ok(partial.sent[1].mediaUrl.includes("topics"));
});

test("invalid explicit zone falls back to valid environment; W reset uses epoch", async () => {
  const h = harness({pluginConfig:{timeZone:"invalid/zone"},env:{OPENCLAW_USAGE_TIMEZONE:"America/New_York"},
    cache:{header:"W:**73%** [synthetic] ~01.07 12:00 🟢",earliestResetAt:Date.UTC(2027,6,1,12,0)}});
  await h.command("header",ownerTopicCommand("w on"));
  const r = await h.on("message_sending",{metadata:{channel:"telegram"},content:"Answer"},{channelId:"telegram",sessionKey:SESSION});
  assert.match(r.content,/~01\.07 08:00/);
  await h.command("limits",directLimits("quota"));
  assert.equal(h.executions[0].at(-1),"America/New_York");
});
