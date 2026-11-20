import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const plugin = readFileSync(path.join(root, "plugin/index.js"), "utf8");
const manifest = JSON.parse(readFileSync(path.join(root, "plugin/openclaw.plugin.json"), "utf8"));
const pkg = JSON.parse(readFileSync(path.join(root, "plugin/package.json"), "utf8"));

test("public package version matches manifest and declares a compatible baseline", () => {
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.activation.onStartup, true);
  assert.equal(pkg.openclaw.compat.minGatewayVersion, "2026.10.4");
});

test("private command is explicitly authenticated", () => {
  assert.match(plugin, /name:\s*"limits"/);
  assert.match(plugin, /requireAuth:\s*true/);
  assert.match(plugin, /isDirectOwnerCommand\(ctx, ownerTelegramId\)/);
  assert.match(plugin, /senderId === ownerTelegramId/);
});

test("both Telegram reply paths and observed model hooks exist", () => {
  for (const name of [
    "reply_payload_sending", "message_sending", "llm_input", "llm_output",
    "model_call_started", "model_call_ended"
  ]) assert.ok(plugin.includes(`api.on("${name}"`), `Missing ${name}`);
  assert.match(plugin, /renderTopicReplyHeader\(/);
  assert.match(plugin, /topicHeaderStore\.change\(scope, action\)/);
  assert.match(plugin, /topicForReply\(event, ctx\)/);
  assert.match(plugin, /name:\s*"header"/);
  assert.match(plugin, /isTopicHeaderOwner\(ctx, api\.pluginConfig\?\.ownerTelegramId\)/);
  assert.match(plugin, /const observed = resolveSessionModel\(ctx, event\)/);
  assert.match(plugin, /const replyAudience = createReplyAudienceTracker\(\)/);
  assert.equal(
    (plugin.match(/replyAudience\.isOwnerReply\(event, ctx, api\.pluginConfig\?\.ownerTelegramId\)/g) ?? []).length,
    2,
    "Both outbound paths must enforce owner-only quota visibility",
  );
  assert.match(plugin, /stripAnswerHeader\(content\)/);
  assert.match(plugin, /stripAnswerHeader\(event\.payload\.text\)/);
});

test("public code does not contain private environment labels", () => {
  assert.doesNotMatch(plugin, /\.bob-limits-media|Europe\/Vilnius/);
  assert.doesNotMatch(plugin, /[\u0400-\u052F]/u);
  assert.equal(manifest.configSchema.properties.reportTitle.description.includes("OpenAI"), true);
});
