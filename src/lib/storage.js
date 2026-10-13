// Versioned, size-bounded, corruption-tolerant persistence for chat history.
// Only conversations are stored. Never API keys or other secrets.

import { DEFAULT_TITLE, TITLE_MAX_LENGTH, sanitizeTitle } from './chatState.js';

export const STORAGE_KEY = 'mitra-ai:history';
export const STORAGE_VERSION = 1;

// Retention policy (documented in the README):
//  - the 50 most recently updated conversations are kept
//  - the newest 200 messages of each conversation are kept
//  - a single message is cut at 60,000 characters
//  - the whole payload is kept under ~2 MB (oldest conversations dropped first)
export const LIMITS = {
  maxSessions: 50,
  maxMessagesPerSession: 200,
  maxMessageChars: 60_000,
  maxChars: 2_000_000,
};

export const INTERRUPTED_BY_RELOAD =
  'This response was interrupted because the page was closed or reloaded.';
const DEFAULT_ERROR = 'The response could not be completed.';

const WARNINGS = {
  unavailable:
    "This browser is blocking local storage, so chats won't be saved after you close the page.",
  unreadable: "Saved chat history couldn't be read, so it was reset.",
  full: "Chats couldn't be saved because browser storage is full.",
};

const isIso = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));

function sanitizeMessage(raw, seen, fallbackTime) {
  if (!raw || typeof raw !== 'object') return null;
  const { id, role, content } = raw;
  if (typeof id !== 'string' || !id || seen.has(id)) return null;
  if (role !== 'user' && role !== 'assistant') return null;
  if (typeof content !== 'string') return null;

  const message = {
    id,
    role,
    content: content.slice(0, LIMITS.maxMessageChars),
    timestamp: isIso(raw.timestamp) ? raw.timestamp : fallbackTime,
  };

  if (role === 'assistant') {
    let status = raw.status;
    let error = typeof raw.error === 'string' ? raw.error.slice(0, 300) : '';
    if (status === 'pending' || status === 'streaming') {
      status = 'error'; // the page went away mid-stream: keep the partial text, flagged
      error = INTERRUPTED_BY_RELOAD;
    }
    if (status !== 'complete' && status !== 'error' && status !== 'stopped') status = 'complete';
    if (status === 'complete' && !message.content.trim()) return null; // no blank bubbles
    if (raw.kind === 'welcome') {
      if (!message.content.trim()) return null;
      message.kind = 'welcome';
    }
    message.status = status;
    if (status === 'error') message.error = error || DEFAULT_ERROR;
    if (raw.messageSent === true) message.messageSent = true;
  }
  seen.add(id);
  return message;
}

function sanitizeSession(raw, seenSessions) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !raw.id || seenSessions.has(raw.id)) return null;
  if (!Array.isArray(raw.messages)) return null;

  const fallbackTime = isIso(raw.updatedAt) ? raw.updatedAt : new Date(0).toISOString();
  const seenMessages = new Set();
  const messages = raw.messages
    .map((m) => sanitizeMessage(m, seenMessages, fallbackTime))
    .filter(Boolean);
  if (messages.length === 0) return null;

  const lastTime = messages[messages.length - 1].timestamp;
  const title = sanitizeTitle(typeof raw.title === 'string' ? raw.title : '') || DEFAULT_TITLE;
  let titleSource = ['default', 'auto', 'user'].includes(raw.titleSource)
    ? raw.titleSource
    : title === DEFAULT_TITLE
      ? 'default'
      : 'auto';
  if (title === DEFAULT_TITLE && titleSource === 'auto') titleSource = 'default';

  seenSessions.add(raw.id);
  return {
    id: raw.id,
    chatId: typeof raw.chatId === 'string' && raw.chatId ? raw.chatId : raw.id,
    title: title.slice(0, TITLE_MAX_LENGTH),
    titleSource,
    createdAt: isIso(raw.createdAt) ? raw.createdAt : messages[0].timestamp,
    updatedAt: isIso(raw.updatedAt) ? raw.updatedAt : lastTime,
    messages,
  };
}

// Validate an already-parsed value. Returns null when it is not usable.
export function sanitizeHistory(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.version !== STORAGE_VERSION || !Array.isArray(raw.sessions)) return null;
  const seen = new Set();
  const sessions = raw.sessions.map((s) => sanitizeSession(s, seen)).filter(Boolean);
  const activeSessionId = sessions.some((s) => s.id === raw.activeSessionId)
    ? raw.activeSessionId
    : (sessions[0]?.id ?? null);
  return { sessions, activeSessionId };
}

export function loadHistory(storage) {
  const empty = { sessions: [], activeSessionId: null };
  if (!storage) return { ...empty, warning: WARNINGS.unavailable };
  let text;
  try {
    text = storage.getItem(STORAGE_KEY);
  } catch {
    return { ...empty, warning: WARNINGS.unavailable };
  }
  if (text === null || text === undefined) return { ...empty, warning: null };
  try {
    const parsed = sanitizeHistory(JSON.parse(text));
    if (!parsed) return { ...empty, warning: WARNINGS.unreadable };
    return { ...parsed, warning: null };
  } catch {
    return { ...empty, warning: WARNINGS.unreadable };
  }
}

const toStored = (session) => ({
  id: session.id,
  chatId: session.chatId,
  title: session.title,
  titleSource: session.titleSource,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
  messages: session.messages.slice(-LIMITS.maxMessagesPerSession).map((m) => {
    const out = {
      id: m.id,
      role: m.role,
      content: m.content.slice(0, LIMITS.maxMessageChars),
      timestamp: m.timestamp,
    };
    if (m.role === 'assistant') {
      out.status = m.status;
      if (m.kind) out.kind = m.kind;
      if (m.error) out.error = m.error;
      if (m.messageSent) out.messageSent = true;
    }
    return out;
  }),
});

const serialize = (sessions, activeSessionId) =>
  JSON.stringify({ version: STORAGE_VERSION, activeSessionId, sessions });

// Apply the retention policy. Returns the sessions that should be stored.
export function applyRetention(sessions, activeSessionId, limits = LIMITS) {
  let kept = sessions.filter((s) => s.messages.length > 0).map(toStored);
  if (kept.length > limits.maxSessions) {
    const hasActive = kept.some((s) => s.id === activeSessionId);
    const keepIds = new Set(
      [...kept]
        .filter((s) => s.id !== activeSessionId)
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .slice(0, limits.maxSessions - (hasActive ? 1 : 0))
        .map((s) => s.id),
    );
    if (hasActive) keepIds.add(activeSessionId); // the open chat is never dropped
    kept = kept.filter((s) => keepIds.has(s.id));
  }
  const oldestFirst = () =>
    kept
      .filter((s) => s.id !== activeSessionId)
      .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
  while (serialize(kept, activeSessionId).length > limits.maxChars) {
    const victim = oldestFirst()[0];
    if (victim) {
      kept = kept.filter((s) => s.id !== victim.id);
      continue;
    }
    // Only the active conversation is left: trim its oldest messages.
    const only = kept[0];
    if (!only || only.messages.length <= 2) break;
    only.messages = only.messages.slice(Math.ceil(only.messages.length * 0.1));
  }
  return kept;
}

export function saveHistory(storage, { sessions, activeSessionId }) {
  if (!storage) return { ok: false, warning: WARNINGS.unavailable };
  let kept = applyRetention(sessions, activeSessionId);
  try {
    if (kept.length === 0) {
      storage.removeItem(STORAGE_KEY);
      return { ok: true };
    }
  } catch {
    return { ok: false, warning: WARNINGS.unavailable };
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      storage.setItem(STORAGE_KEY, serialize(kept, activeSessionId));
      return { ok: true };
    } catch {
      // Most likely QuotaExceededError: drop the older half and retry.
      const droppable = kept
        .filter((s) => s.id !== activeSessionId)
        .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
      if (droppable.length === 0) break;
      const drop = new Set(droppable.slice(0, Math.ceil(droppable.length / 2)).map((s) => s.id));
      kept = kept.filter((s) => !drop.has(s.id));
    }
  }
  return { ok: false, warning: WARNINGS.full };
}

export function clearHistory(storage) {
  try {
    storage?.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}
