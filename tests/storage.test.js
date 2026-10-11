import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStorage } from './helpers.js';
import {
  INTERRUPTED_BY_RELOAD,
  LIMITS,
  STORAGE_KEY,
  STORAGE_VERSION,
  applyRetention,
  clearHistory,
  loadHistory,
  saveHistory,
} from '../src/lib/storage.js';

const iso = (n) => new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString();
const session = (id, n, messages) => ({
  id,
  chatId: `chat-${id}`,
  title: `Chat ${id}`,
  titleSource: 'auto',
  createdAt: iso(n),
  updatedAt: iso(n),
  messages: messages ?? [
    { id: `${id}-u`, role: 'user', content: 'hello', timestamp: iso(n) },
    { id: `${id}-a`, role: 'assistant', content: 'hi', timestamp: iso(n), status: 'complete' },
  ],
});

test('round trip preserves order, ids, titles, timestamps and active session', () => {
  const storage = new MemoryStorage();
  const sessions = [session('b', 2), session('a', 1)];
  assert.ok(saveHistory(storage, { sessions, activeSessionId: 'a' }).ok);
  const loaded = loadHistory(storage);
  assert.equal(loaded.warning, null);
  assert.equal(loaded.activeSessionId, 'a');
  assert.deepEqual(loaded.sessions.map((s) => s.id), ['b', 'a']);
  assert.deepEqual(loaded.sessions[0].messages.map((m) => m.id), ['b-u', 'b-a']);
  assert.equal(loaded.sessions[0].chatId, 'chat-b');
  assert.equal(loaded.sessions[0].messages[0].timestamp, iso(2));
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).version, STORAGE_VERSION);
});

test('missing data loads as empty with no warning', () => {
  const r = loadHistory(new MemoryStorage());
  assert.deepEqual([r.sessions, r.activeSessionId, r.warning], [[], null, null]);
});

test('malformed, wrong-version and wrong-shape data never throw', () => {
  const bad = [
    '{not json',
    'null',
    '42',
    '"text"',
    '[]',
    JSON.stringify({ version: 999, sessions: [] }),
    JSON.stringify({ version: 0, sessions: [] }),
    JSON.stringify({ version: STORAGE_VERSION, sessions: 'x' }),
  ];
  for (const text of bad) {
    const storage = new MemoryStorage({ [STORAGE_KEY]: text });
    const r = loadHistory(storage);
    assert.deepEqual(r.sessions, [], text);
    assert.ok(r.warning, `warning for ${text}`);
  }
});

test('invalid entries inside valid data are dropped, valid ones survive', () => {
  const raw = {
    version: STORAGE_VERSION,
    activeSessionId: 'missing',
    sessions: [
      null,
      { id: 5 },
      session('dup', 1),
      session('dup', 2), // duplicate id
      { ...session('x', 3), messages: [{ id: 'm', role: 'robot', content: 'hi' }, { id: 'n', role: 'user' }] },
      { ...session('ok', 4), title: 42 },
    ],
  };
  const r = loadHistory(new MemoryStorage({ [STORAGE_KEY]: JSON.stringify(raw) }));
  assert.deepEqual(r.sessions.map((s) => s.id), ['dup', 'ok']);
  assert.equal(r.activeSessionId, 'dup'); // unknown active id falls back to the first session
  assert.equal(r.sessions[1].title, 'New chat');
});

test('a reply that was streaming when the page closed comes back flagged as interrupted', () => {
  const s = session('s', 1, [
    { id: 'u', role: 'user', content: 'q', timestamp: iso(1) },
    { id: 'a', role: 'assistant', content: 'partial', timestamp: iso(1), status: 'streaming' },
  ]);
  const r = loadHistory(new MemoryStorage({ [STORAGE_KEY]: JSON.stringify({ version: 1, activeSessionId: 's', sessions: [s] }) }));
  const msg = r.sessions[0].messages[1];
  assert.equal(msg.status, 'error');
  assert.equal(msg.error, INTERRUPTED_BY_RELOAD);
  assert.equal(msg.content, 'partial');
});

test('blank completed assistant bubbles are not restored', () => {
  const s = session('s', 1, [
    { id: 'u', role: 'user', content: 'q', timestamp: iso(1) },
    { id: 'a', role: 'assistant', content: '   ', timestamp: iso(1), status: 'complete' },
  ]);
  const r = loadHistory(new MemoryStorage({ [STORAGE_KEY]: JSON.stringify({ version: 1, sessions: [s] }) }));
  assert.equal(r.sessions[0].messages.length, 1);
});

test('empty sessions are not stored and saving nothing removes the key', () => {
  const storage = new MemoryStorage();
  saveHistory(storage, { sessions: [session('a', 1)], activeSessionId: 'a' });
  assert.ok(storage.getItem(STORAGE_KEY));
  saveHistory(storage, { sessions: [{ ...session('e', 2), messages: [] }], activeSessionId: 'e' });
  assert.equal(storage.getItem(STORAGE_KEY), null);
});

test('retention keeps the newest sessions and messages', () => {
  const many = Array.from({ length: LIMITS.maxSessions + 5 }, (_, i) => session(`s${i}`, i));
  const kept = applyRetention(many, 's0');
  assert.equal(kept.length, LIMITS.maxSessions);
  assert.ok(kept.some((s) => s.id === 's0'), 'the active session is never dropped');
  assert.ok(!kept.some((s) => s.id === 's1'), 'oldest inactive sessions go first');

  const longMessages = Array.from({ length: LIMITS.maxMessagesPerSession + 20 }, (_, i) => ({
    id: `m${i}`, role: 'user', content: `msg ${i}`, timestamp: iso(1),
  }));
  const [trimmed] = applyRetention([session('long', 1, longMessages)], 'long');
  assert.equal(trimmed.messages.length, LIMITS.maxMessagesPerSession);
  assert.equal(trimmed.messages.at(-1).id, `m${LIMITS.maxMessagesPerSession + 19}`);
});

test('the total size is bounded', () => {
  const big = 'x'.repeat(50_000);
  const sessions = Array.from({ length: 40 }, (_, i) =>
    session(`s${i}`, i, [
      { id: `u${i}`, role: 'user', content: big, timestamp: iso(i) },
      { id: `a${i}`, role: 'assistant', content: big, timestamp: iso(i), status: 'complete' },
    ]),
  );
  const kept = applyRetention(sessions, 's39');
  assert.ok(JSON.stringify({ sessions: kept }).length <= LIMITS.maxChars + 1000);
  assert.ok(kept.some((s) => s.id === 's39'));
});

test('quota errors drop old chats instead of throwing; total failure is reported', () => {
  const storage = new MemoryStorage();
  const real = storage.setItem.bind(storage);
  storage.setItem = (k, v) => {
    if (v.length > 2000) throw new Error('QuotaExceededError');
    return real(k, v);
  };
  const sessions = Array.from({ length: 8 }, (_, i) => session(`s${i}`, i, [
    { id: `u${i}`, role: 'user', content: 'x'.repeat(400), timestamp: iso(i) },
  ]));
  const r = saveHistory(storage, { sessions, activeSessionId: 's7' });
  assert.ok(r.ok);
  assert.ok(loadHistory(storage).sessions.some((s) => s.id === 's7'));

  storage.failWrites = true;
  storage.setItem = () => { throw new Error('QuotaExceededError'); };
  const fail = saveHistory(storage, { sessions, activeSessionId: 's7' });
  assert.equal(fail.ok, false);
  assert.ok(fail.warning);
});

test('unavailable storage degrades gracefully; clearHistory removes the key', () => {
  assert.ok(loadHistory(null).warning);
  assert.equal(saveHistory(null, { sessions: [session('a', 1)], activeSessionId: 'a' }).ok, false);
  const throwing = { getItem() { throw new Error('denied'); } };
  assert.ok(loadHistory(throwing).warning);
  const storage = new MemoryStorage();
  saveHistory(storage, { sessions: [session('a', 1)], activeSessionId: 'a' });
  assert.ok(clearHistory(storage));
  assert.equal(storage.getItem(STORAGE_KEY), null);
});

test('only conversation data is written (no extra fields leak into storage)', () => {
  const storage = new MemoryStorage();
  const s = { ...session('a', 1), awaitingWelcome: true, apiKey: 'secret' };
  saveHistory(storage, { sessions: [s], activeSessionId: 'a' });
  const text = storage.getItem(STORAGE_KEY);
  assert.ok(!text.includes('secret'));
  assert.ok(!text.includes('awaitingWelcome'));
});
