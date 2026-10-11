// Pure helpers for sessions, titles, search and export. No React, no DOM.

export const DEFAULT_TITLE = 'New chat';
export const TITLE_PREVIEW_LENGTH = 48;
export const TITLE_MAX_LENGTH = 80;

export function createSession({ id, chatId, now }) {
  return {
    id,
    chatId, // identifier the provider uses to keep its own conversation memory
    title: DEFAULT_TITLE,
    titleSource: 'default', // 'default' | 'auto' | 'user'
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

export function hasUserMessages(session) {
  return Boolean(session) && session.messages.some((m) => m.role === 'user');
}

function truncate(text, max) {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  let cut = chars.slice(0, max).join('');
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > max * 0.6) cut = cut.slice(0, lastSpace);
  return `${cut.replace(/[\s.,;:!?\-–—]+$/u, '')}…`;
}

// Title from the first meaningful line of a user message.
export function deriveTitle(text) {
  if (typeof text !== 'string') return null;
  const lines = text.replace(/```[^\n]*\n?/g, '\n').split('\n');
  for (const raw of lines) {
    const line = raw
      .replace(/^(?:\s*(?:[>#*+-]+|\d+[.)])\s+)+/u, '')
      .replace(/[*_`~]+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (/[\p{L}\p{N}]{2,}/u.test(line)) return truncate(line, TITLE_PREVIEW_LENGTH);
  }
  return null;
}

// Title typed by the user when renaming.
export function sanitizeTitle(raw) {
  if (typeof raw !== 'string') return '';
  const clean = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(clean).slice(0, TITLE_MAX_LENGTH).join('').trim();
}

export function matchesSearch(session, query) {
  const q = (query ?? '').trim().toLowerCase();
  if (!q) return true;
  if (session.title.toLowerCase().includes(q)) return true;
  return session.messages.some((m) => m.content.toLowerCase().includes(q));
}

export function formatRelativeTime(iso, nowMs = Date.now()) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diff = nowMs - t;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return 'Just now';
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  const date = new Date(t);
  const sameYear = date.getFullYear() === new Date(nowMs).getFullYear();
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

export function conversationToMarkdown(session, nowMs = Date.now()) {
  const exported = new Date(nowMs).toISOString().slice(0, 10);
  const parts = [`# ${session.title}`, `_Exported from Mitra AI on ${exported}_`];
  for (const m of session.messages) {
    if (!m.content.trim()) continue;
    const label = m.role === 'user' ? 'You' : 'Mitra AI';
    const note =
      m.role === 'assistant' && m.status === 'error'
        ? '\n\n_(response incomplete)_'
        : m.role === 'assistant' && m.status === 'stopped'
          ? '\n\n_(generation stopped)_'
          : '';
    parts.push(`## ${label}\n\n${m.content.trim()}${note}`);
  }
  return `${parts.join('\n\n')}\n`;
}

export function exportFilename(session, nowMs = Date.now()) {
  const slug = session.title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  const date = new Date(nowMs).toISOString().slice(0, 10);
  return `mitra-ai-${slug || 'conversation'}-${date}.md`;
}
