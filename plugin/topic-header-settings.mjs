import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

// A topic's configuration is shared by every agent/model routed to it.
export const DEFAULT_LINES = Object.freeze({ w: false, m: true });
export const NO_LINES = Object.freeze({ w: false, m: false });
const SESSION = /^agent:[^:]+:telegram:group:(-100[0-9]+):topic:([1-9][0-9]*)$/u;
const TOPIC_KEY = /^telegram:group:-100[0-9]+:topic:[1-9][0-9]*$/u;

function topicNumber(value) {
  const raw = String(value ?? "").trim();
  return /^[1-9][0-9]*$/u.test(raw) ? raw : null;
}

function chatNumber(value) {
  const raw = String(value ?? "").trim();
  return /^(?:telegram:)?(-100[0-9]+)$/u.exec(raw)?.[1] ??
    /^telegram:group:(-100[0-9]+)(?::topic:[1-9][0-9]*)?$/u.exec(raw)?.[1] ??
    null;
}

export function topicFromSession(sessionKey) {
  const found = SESSION.exec(String(sessionKey ?? "").trim());
  return found ? "telegram:group:" + found[1] + ":topic:" + found[2] : null;
}

export function topicForCommand(ctx = {}) {
  if (ctx.channel !== "telegram") return null;
  const session = String(ctx.sessionKey ?? "").trim();
  const fromSession = topicFromSession(session);
  // A supplied but unrelated session is never a basis for a topic write.
  if (session && !fromSession) return null;
  const thread = ctx.messageThreadId == null ? null : topicNumber(ctx.messageThreadId);
  if (ctx.messageThreadId != null && !thread) return null;
  const from = String(ctx.from ?? "").trim();
  const chat = chatNumber(from);
  if (from && !chat) return null;
  if (fromSession) {
    const found = /^telegram:group:(-100[0-9]+):topic:([1-9][0-9]*)$/u.exec(fromSession);
    if (thread && thread !== found[2]) return null;
    if (chat && chat !== found[1]) return null;
    return fromSession;
  }
  return chat && thread ? "telegram:group:" + chat + ":topic:" + thread : null;
}

export function topicForReply(event = {}, ctx = {}) {
  const session = String(ctx.sessionKey ?? event.sessionKey ?? "").trim();
  const delivery = event.delivery ?? {};
  const rawThread = ctx.messageThreadId ?? event.threadId ??
    event.messageThreadId ?? delivery.threadId;
  const thread = topicNumber(rawThread);
  const chat = chatNumber(ctx.conversationId ?? event.to ?? delivery.to ?? ctx.channelId);
  if (session) {
    const exact = topicFromSession(session);
    if (!exact) return null;
    const found = /^telegram:group:(-100[0-9]+):topic:([1-9][0-9]*)$/u.exec(exact);
    if (rawThread != null && thread !== found[2]) return null;
    if (chat && chat !== found[1]) return null;
    return exact;
  }
  // Missing or inconsistent routing evidence must not inherit an override.
  return chat && thread ? "telegram:group:" + chat + ":topic:" + thread : null;
}

export function parseHeaderAction(args) {
  const action = String(args ?? "").trim().toLowerCase().replace(/\s+/gu, " ");
  if (!action || action === "status") return { type: "status" };
  if (action === "reset") return { type: "reset" };
  if (action === "on" || action === "off") {
    return { type: "set", lines: { w: action === "on", m: action === "on" } };
  }
  const found = /^([wm]) (on|off)$/u.exec(action);
  return found ? { type: "set", lines: { [found[1]]: found[2] === "on" } } : null;
}

function validateState(data) {
  if (!data || data.version !== 1 || !data.topics ||
      typeof data.topics !== "object" || Array.isArray(data.topics)) {
    throw Error("Invalid topic header state");
  }
  for (const [key, lines] of Object.entries(data.topics)) {
    if (!TOPIC_KEY.test(key) || !lines ||
        typeof lines.w !== "boolean" || typeof lines.m !== "boolean") {
      throw Error("Invalid topic header preference");
    }
  }
  return data;
}

export function createTopicHeaderStore(filePath) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
    throw Error("Absolute private state path required");
  }
  let pending = Promise.resolve();

  async function readState() {
    try {
      return validateState(JSON.parse(await readFile(filePath, "utf8")));
    } catch (error) {
      if (error?.code === "ENOENT") return { version: 1, topics: {} };
      throw error;
    }
  }

  async function read(topicKey) {
    if (!TOPIC_KEY.test(String(topicKey ?? ""))) throw Error("Invalid topic");
    await pending;
    const state = await readState();
    return { ...DEFAULT_LINES, ...state.topics[topicKey] };
  }

  async function writeState(state) {
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = filePath + "." + process.pid + "." + randomUUID() + ".tmp";
    try {
      await writeFile(temporary, JSON.stringify(state, null, 2) + "\n", {
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, filePath);
    } finally {
      await unlink(temporary).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
  }

  function change(topicKey, action) {
    if (!TOPIC_KEY.test(String(topicKey ?? ""))) {
      return Promise.reject(Error("Invalid topic"));
    }
    const next = pending.catch(() => {}).then(async () => {
      const state = await readState();
      if (action.type === "reset") {
        delete state.topics[topicKey];
      } else if (action.type === "set") {
        const old = { ...DEFAULT_LINES, ...state.topics[topicKey] };
        state.topics[topicKey] = { ...old, ...action.lines };
      } else {
        throw Error("Unsupported change");
      }
      await writeState(state);
      return { ...DEFAULT_LINES, ...state.topics[topicKey] };
    });
    pending = next.then(() => undefined, () => undefined);
    return next;
  }

  return { read, change };
}
