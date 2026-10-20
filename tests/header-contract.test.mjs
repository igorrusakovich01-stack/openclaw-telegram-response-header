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
  assert.match(plugin, /alreadyHasUsageHeader\(content\)/);
  assert.match(plugin, /const model = resolveSessionModel\(ctx, event\)/);
});

test("public code does not contain private environment labels", () => {
  assert.doesNotMatch(plugin, /\.bob-limits-media|Europe\/Vilnius/);
  assert.doesNotMatch(plugin, /[\u0400-\u052F]/u);
  assert.equal(manifest.configSchema.properties.reportTitle.description.includes("OpenAI"), true);
});
