import test from "node:test";
import assert from "node:assert/strict";
import {
  createReplyAudienceTracker, telegramId, stripAnswerHeader, compactModelLine,
} from "../plugin/reply-audience.mjs";

const OWNER = "111111111";
const OTHER = "222222222";
const SESSION = "agent:main:telegram:group:-100123:topic:17";
const inbound = (senderId, runId, messageId) => ({
  event: { channel: "telegram", senderId, runId, messageId },
  ctx: { channelId: "telegram", senderId, sessionKey: SESSION, runId, messageId },
});

test("Telegram numeric and prefixed IDs normalize exactly", () => {
  assert.equal(telegramId("telegram:" + OWNER), OWNER);
  assert.equal(telegramId(OWNER), OWNER);
  assert.equal(telegramId("bob"), null);
});

test("owner and other user in the same topic remain separate", () => {
  const tracker = createReplyAudienceTracker();
  const a = inbound(OWNER, "run-owner", "101");
  const b = inbound(OTHER, "run-other", "102");
  tracker.remember(a.event, a.ctx);
  tracker.remember(b.event, b.ctx);
  assert.equal(tracker.isOwnerReply({ runId: "run-owner" }, { runId: "run-owner", sessionKey: SESSION }, OWNER), true);
  assert.equal(tracker.isOwnerReply({ runId: "run-other" }, { runId: "run-other", sessionKey: SESSION }, OWNER), false);
  assert.equal(tracker.isOwnerReply({}, { sessionKey: SESSION }, OWNER), false);
});

test("a numeric channelId may identify the chat, not the provider", () => {
  const tracker = createReplyAudienceTracker();
  const sample = inbound(OWNER, "numeric-channel-run", "701");
  tracker.remember(sample.event, { ...sample.ctx, channelId: "-100123" });
  assert.equal(tracker.isOwnerReply(
    { runId: "numeric-channel-run" },
    { runId: "numeric-channel-run", sessionKey: SESSION },
    OWNER,
  ), true);
});

test("an exact inbound message ID can correlate when run ID is absent", () => {
  const tracker = createReplyAudienceTracker();
  const a = inbound(OWNER, null, "201");
  tracker.remember(a.event, a.ctx);
  assert.equal(tracker.isOwnerReply({}, { sessionKey: SESSION, messageId: "201" }, OWNER), true);
  assert.equal(tracker.isOwnerReply({}, { sessionKey: SESSION, messageId: "202" }, OWNER), false);
});

test("sender mismatch, session mismatch and missing ID all fail closed", () => {
  const tracker = createReplyAudienceTracker();
  const a = inbound(OWNER, "owner-run", "301");
  tracker.remember(a.event, a.ctx);
  assert.equal(tracker.isOwnerReply({ runId: "owner-run" }, { senderId: OTHER, runId: "owner-run" }, OWNER), false);
  assert.equal(tracker.isOwnerReply({ runId: "owner-run" }, { runId: "owner-run", sessionKey: "different" }, OWNER), false);
  assert.equal(tracker.isOwnerReply({}, {}, null), false);
});

test("outbound sender evidence cannot disagree between event and context", () => {
  const tracker = createReplyAudienceTracker();
  const a = inbound(OWNER, "owner-run-conflict", "601");
  tracker.remember(a.event, a.ctx);
  assert.equal(tracker.isOwnerReply(
    { senderId: OTHER, runId: "owner-run-conflict" },
    { senderId: OWNER, runId: "owner-run-conflict", sessionKey: SESSION },
    OWNER,
  ), false);
  assert.equal(tracker.isOwnerReply(
    { senderId: OTHER, runId: "owner-run-conflict" },
    { runId: "owner-run-conflict", sessionKey: SESSION },
    OWNER,
  ), false);
  assert.equal(tracker.isOwnerReply(
    { senderId: OWNER, runId: "owner-run-conflict" },
    { runId: "owner-run-conflict", sessionKey: SESSION },
    OWNER,
  ), true);
});

test("expired correlations cannot authorize an indicator", () => {
  let clock = 100;
  const tracker = createReplyAudienceTracker({ now: () => clock, ttlMs: 1000 });
  const a = inbound(OWNER, "run-expired", "401");
  tracker.remember(a.event, a.ctx);
  clock = 1200;
  assert.equal(tracker.isOwnerReply({ runId: "run-expired" }, { runId: "run-expired" }, OWNER), false);
});

test("no sender is inferred from ambiguous inbound records", () => {
  const tracker = createReplyAudienceTracker();
  tracker.remember({ channel: "telegram", senderId: OWNER, runId: "bad" },
    { channelId: "telegram", senderId: OTHER, runId: "bad" });
  assert.equal(tracker.isOwnerReply({}, { runId: "bad" }, OWNER), false);
});

test("W/M and model-only headers are both removed without altering body", () => {
  assert.equal(stripAnswerHeader("W:36%\nM:**x**\n\nText"), "Text");
  assert.equal(stripAnswerHeader("M:**x**\n\nText"), "Text");
  assert.equal(stripAnswerHeader("Text"), "Text");
  assert.equal(compactModelLine("M:**openai/gpt-6.1-sol** upd 17.11 15:58"), "M:**openai/gpt-6.1-sol**");
});
