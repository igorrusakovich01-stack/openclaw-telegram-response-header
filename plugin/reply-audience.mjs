// Fail closed: never infer the author from the last message in a group or topic.
export function telegramId(value) {
  const raw = String(value ?? "").trim();
  return /^telegram:(\d+)$/u.exec(raw)?.[1] ??
    (/^\d+$/u.test(raw) ? raw : null);
}

export function createReplyAudienceTracker({
  now = () => Date.now(),
  ttlMs = 10 * 60 * 1000,
  maxRecords = 1024,
} = {}) {
  const byRun = new Map();
  const byMessage = new Map();

  function prune() {
    const at = now();
    for (const cache of [byRun, byMessage]) {
      for (const [key, record] of cache) {
        if (at < record.ts || at - record.ts > ttlMs) cache.delete(key);
      }
      while (cache.size > maxRecords) cache.delete(cache.keys().next().value);
    }
  }

  function remember(event, ctx) {
    if ((ctx?.channelId ?? event?.channel ?? event?.metadata?.channel) !== "telegram") return;
    const fromContext = telegramId(ctx?.senderId);
    const fromEvent = telegramId(event?.senderId);
    if (fromContext && fromEvent && fromContext !== fromEvent) return;
    const sender = fromContext ?? fromEvent;
    if (!sender) return;

    const runId = String(ctx?.runId ?? event?.runId ?? "").trim();
    const sessionKey = String(ctx?.sessionKey ?? event?.sessionKey ?? "").trim();
    const messageId = String(ctx?.messageId ?? event?.messageId ?? "").trim();
    if (!runId && !(sessionKey && messageId)) return;

    const record = { sender, sessionKey, ts: now() };
    prune();
    if (runId) byRun.set(runId, record);
    if (sessionKey && messageId) byMessage.set(sessionKey + "\u0000" + messageId, record);
    prune();
  }

  function isOwnerReply(event, ctx, configuredOwnerId) {
    const owner = telegramId(configuredOwnerId);
    if (!owner) return false;
    prune();

    const contextSender = telegramId(ctx?.senderId);
    const eventSender = telegramId(event?.senderId);
    // Conflicting sender evidence must never authorize the quota header.
    if (contextSender && eventSender && contextSender !== eventSender) return false;
    const sender = contextSender ?? eventSender;
    const runId = String(ctx?.runId ?? event?.runId ?? "").trim();
    const sessionKey = String(ctx?.sessionKey ?? event?.sessionKey ?? "").trim();
    const messageId = String(ctx?.messageId ?? event?.messageId ?? "").trim();
    const found = [];
    if (runId && byRun.has(runId)) found.push(byRun.get(runId));
    if (sessionKey && messageId && byMessage.has(sessionKey + "\u0000" + messageId)) {
      found.push(byMessage.get(sessionKey + "\u0000" + messageId));
    }
    if (sender && sender !== owner) return false;
    if (found.some((record) =>
      record.sender !== owner ||
      (sessionKey && record.sessionKey && record.sessionKey !== sessionKey)
    )) return false;
    // A confirmed outbound sender is sufficient. Otherwise require a matching
    // inbound runId or sessionKey+messageId; session-only is ambiguous.
    return sender === owner || found.length > 0;
  }

  return { remember, isOwnerReply };
}

export function stripAnswerHeader(text) {
  return String(text ?? "").replace(
    /^\s*(?:W:[^\n]*\n)?M:[^\n]*(?:\n\s*)?/u,
    "",
  );
}

export function compactModelLine(text) {
  const modelLine = /^\s*(?:W:[^\n]*\n)?(M:[^\n]*)/u.exec(String(text ?? ""))?.[1];
  const model = /^M:\*\*([^*\n]+)\*\*/u.exec(modelLine ?? "")?.[1];
  return model ? `M:**${model}**` : "M:**?**";
}
