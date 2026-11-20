import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTopicHeaderStore, parseHeaderAction, topicFromSession,
  topicForCommand, topicForReply, DEFAULT_LINES } from "../plugin/topic-header-settings.mjs";

const SESSION = "agent:group-answers:telegram:group:-100123:topic:17";
const KEY = "telegram:group:-100123:topic:17";

test("different agents in the same topic share a persistent scope", () => {
  assert.equal(topicFromSession(SESSION), KEY);
  assert.equal(topicFromSession("agent:other:telegram:group:-100123:topic:17"), KEY);
  assert.equal(topicFromSession("agent:other:telegram:group:-100123:topic:18"),
    "telegram:group:-100123:topic:18");
  assert.equal(topicFromSession("agent:test:telegram:direct:123"), null);
});

test("command scope rejects untrusted and contradictory routing", () => {
  const ctx = {
    channel: "telegram", sessionKey: SESSION,
    from: "telegram:group:-100123", messageThreadId: 17,
  };
  assert.equal(topicForCommand(ctx), KEY);
  assert.equal(topicForCommand({ ...ctx, messageThreadId: 18 }), null);
  assert.equal(topicForCommand({ ...ctx, from: "telegram:group:-100999" }), null);
  assert.equal(topicForCommand({ ...ctx, channel: "discord" }), null);
  assert.equal(topicForCommand({ ...ctx, sessionKey: "agent:test:telegram:direct:123" }), null);
  assert.equal(topicForCommand({
    channel: "telegram", from: "telegram:group:-100123", messageThreadId: 17,
  }), KEY);
  assert.equal(topicForCommand({ channel: "telegram", messageThreadId: 17 }), null);
});

test("reply scope accepts an exact session or verified outbound topic target", () => {
  assert.equal(topicForReply({}, { sessionKey: SESSION }), KEY);
  assert.equal(topicForReply({ to: "-100123", threadId: 17 }, {}), KEY);
  assert.equal(topicForReply({ to: "-100123" }, {}), null);
  assert.equal(topicForReply({ to: "-100123", threadId: 18 }, { sessionKey: SESSION }), KEY);
  assert.equal(topicForReply({}, { sessionKey: "agent:test:telegram:direct:123" }), null);
});

test("parse independent lines and reset without accepting arbitrary arguments", () => {
  assert.deepEqual(parseHeaderAction(""), { type: "status" });
  assert.deepEqual(parseHeaderAction("w off"), { type: "set", lines: { w: false } });
  assert.deepEqual(parseHeaderAction("M ON"), { type: "set", lines: { m: true } });
  assert.deepEqual(parseHeaderAction("off"), { type: "set", lines: { w: false, m: false } });
  assert.deepEqual(parseHeaderAction("reset"), { type: "reset" });
  assert.equal(parseHeaderAction("w toggle"), null);
  assert.equal(parseHeaderAction("m on\nw on"), null);
  assert.equal(parseHeaderAction("../../secret"), null);
});

test("preferences persist, are isolated by chat/topic and use a private file", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "header-topics-"));
  const filename = path.join(dir, "topics.json");
  const store = createTopicHeaderStore(filename);

  assert.deepEqual(await store.read(KEY), DEFAULT_LINES);
  await store.change(KEY, parseHeaderAction("w on"));
  await store.change(KEY, parseHeaderAction("m off"));
  assert.deepEqual(await store.read(KEY), { w: true, m: false });
  assert.deepEqual(await store.read("telegram:group:-100123:topic:18"), DEFAULT_LINES);
  assert.deepEqual(await store.read("telegram:group:-100999:topic:17"), DEFAULT_LINES);

  const reloaded = createTopicHeaderStore(filename);
  assert.deepEqual(await reloaded.read(KEY), { w: true, m: false });
  const contents = JSON.parse(await readFile(filename, "utf8"));
  assert.equal(contents.version, 1);
  assert.deepEqual(contents.topics[KEY], { w: true, m: false });

  await reloaded.change(KEY, parseHeaderAction("reset"));
  assert.deepEqual(await store.read(KEY), DEFAULT_LINES);
});

test("sequential updates never discard another line", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "header-serialized-"));
  const store = createTopicHeaderStore(path.join(dir, "topics.json"));
  await Promise.all([
    store.change(KEY, parseHeaderAction("w on")),
    store.change(KEY, parseHeaderAction("m off")),
  ]);
  assert.deepEqual(await store.read(KEY), { w: true, m: false });
});

test("corrupt state fails closed and is not overwritten", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "header-bad-"));
  const filename = path.join(dir, "topics.json");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(filename, "{not valid json");
  const store = createTopicHeaderStore(filename);
  await assert.rejects(store.read(KEY));
  await assert.rejects(store.change(KEY, parseHeaderAction("m off")));
  assert.equal(await readFile(filename, "utf8"), "{not valid json");
});
