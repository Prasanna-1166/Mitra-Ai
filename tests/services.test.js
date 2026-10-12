import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeSupabase } from './fakeSupabase.js';
import { createCloudStore, importGuestHistory } from '../src/services/conversationService.js';
import { MemoryRejectedError, createMemoryStore, createSettingsStore } from '../src/services/memoryService.js';
import { createTicketClient } from '../src/services/usageService.js';
import { validateEmail, validatePassword, friendlyAuthError } from '../src/services/authService.js';
import { MemoryStorage } from './helpers.js';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const id = (n) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;

function setup() {
  const db = new FakeSupabase();
  db.uid = A;
  return { db, a: createCloudStore(db, A) };
}
const local = (n, count = 3, extra = {}) => ({
  id: id(n), title: `Guest chat ${n}`, titleSource: 'auto',
  createdAt: `2026-03-0${n}T10:00:00.000Z`, updatedAt: `2026-03-0${n}T11:00:00.000Z`,
  messages: Array.from({ length: count }, (_, i) => ({
    id: id(n * 100 + i), role: i % 2 === 0 ? 'user' : 'assistant', content: `msg ${i}`,
    timestamp: `2026-03-0${n}T10:0${i}:00.000Z`, ...(i % 2 ? { status: 'complete' } : {}),
  })),
  ...extra,
});

test('conversations: create, list newest first, rename, delete', async () => {
  const { a } = setup();
  await a.createConversation({ id: id(1), title: 'First', titleSource: 'auto' });
  await a.createConversation({ id: id(2), title: 'Second', titleSource: 'default' });
  await a.createConversation({ id: id(2), title: 'Second', titleSource: 'default' }); // retry is harmless
  let { items } = await a.listConversations();
  assert.equal(items.length, 2);
  await a.renameConversation(id(1), 'Renamed');
  items = (await a.listConversations()).items;
  assert.equal(items.find((c) => c.id === id(1)).title, 'Renamed');
  assert.equal(items.find((c) => c.id === id(1)).titleSource, 'user');
  await a.deleteConversation(id(1));
  assert.deepEqual((await a.listConversations()).items.map((c) => c.id), [id(2)]);
});

test('messages: stable order, pagination in manageable batches, mapped ids and statuses', async () => {
  const { db, a } = setup();
  await a.createConversation({ id: id(1), title: 'Chat', titleSource: 'auto' });
  for (let i = 0; i < 7; i += 1) {
    db.tables.messages.push({ id: id(500 + i), seq: ++db.seq, conversation_id: id(1), user_id: A, client_id: id(900 + i), role: i % 2 ? 'assistant' : 'user', content: `m${i}`, status: 'complete', error: null, created_at: db.now() });
  }
  const latest = await a.loadMessages(id(1), { limit: 3 });
  assert.deepEqual(latest.messages.map((m) => m.content), ['m4', 'm5', 'm6']);
  assert.equal(latest.hasMore, true);
  assert.equal(latest.messages[0].id, id(904), 'the client id is used as the message id');
  const older = await a.loadMessages(id(1), { beforeSeq: latest.messages[0].seq, limit: 3 });
  assert.deepEqual(older.messages.map((m) => m.content), ['m1', 'm2', 'm3']);
  const all = await a.loadAllMessages(id(1));
  assert.deepEqual(all.map((m) => m.content), ['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6']);
  assert.equal(all[1].status, 'complete');
  assert.equal(all[0].status, undefined);
});

test('clearing messages and deleting a conversation remove the intended rows only', async () => {
  const { db, a } = setup();
  await a.importConversation(local(1));
  await a.importConversation(local(2));
  const conv1 = db.tables.conversations.find((c) => c.import_key === id(1)).id;
  await a.clearMessages(conv1);
  assert.equal(db.tables.messages.filter((m) => m.conversation_id === conv1).length, 0);
  assert.equal(db.tables.messages.length, 3, 'the other conversation keeps its messages');
  await a.deleteAllConversations();
  assert.equal(db.tables.conversations.length, 0);
  assert.equal(db.tables.messages.length, 0);
});

test('import preserves order, timestamps, titles and roles', async () => {
  const { db, a } = setup();
  const cid = await a.importConversation(local(1));
  const conv = db.tables.conversations.find((c) => c.id === cid);
  assert.equal(conv.title, 'Guest chat 1');
  assert.equal(conv.created_at, '2026-03-01T10:00:00.000Z');
  const rows = db.tables.messages.filter((m) => m.conversation_id === cid).sort((x, y) => x.seq - y.seq);
  assert.deepEqual(rows.map((r) => [r.role, r.content, r.created_at]), [
    ['user', 'msg 0', '2026-03-01T10:00:00.000Z'],
    ['assistant', 'msg 1', '2026-03-01T10:01:00.000Z'],
    ['user', 'msg 2', '2026-03-01T10:02:00.000Z'],
  ]);
});

test('import is idempotent: repeating it (or retrying after a failure) never duplicates', async () => {
  const { db, a } = setup();
  const sessions = [local(1), local(2, 5), local(3, 2)];
  db.failNext = { table: 'messages', op: 'upsert' }; // the first message batch fails
  await assert.rejects(() => importGuestHistory(a, sessions));
  await importGuestHistory(a, sessions); // retry
  await importGuestHistory(a, sessions); // and again
  assert.equal(db.tables.conversations.length, 3);
  assert.equal(db.tables.messages.length, 10);
  assert.equal(new Set(db.tables.messages.map((m) => `${m.conversation_id}:${m.client_id}`)).size, 10);
});

test('import handles large histories in batches and reports progress', async () => {
  const { db, a } = setup();
  const big = local(1, 250);
  const progress = [];
  await a.importConversation(big, { onProgress: (done, total) => progress.push([done, total]) });
  assert.equal(db.tables.messages.length, 250);
  assert.deepEqual(progress.at(-1), [250, 250]);
  assert.ok(progress.length >= 3);
});

test('import skips invalid message ids and truncates oversize content safely', async () => {
  const { db, a } = setup();
  const s = local(1, 2);
  s.messages.push({ id: 'not-a-uuid', role: 'user', content: 'x', timestamp: s.createdAt });
  s.messages.push({ id: id(777), role: 'user', content: 'y'.repeat(70000), timestamp: s.createdAt });
  await a.importConversation(s);
  assert.equal(db.tables.messages.length, 3);
  assert.equal(Math.max(...db.tables.messages.map((m) => m.content.length)), 60000);
});

test('account isolation at the service layer: B never sees or changes A\'s data', async () => {
  const { db, a } = setup();
  await a.importConversation(local(1));
  const memA = createMemoryStore(db, A);
  const mem = await memA.create({ content: 'I prefer Python', category: 'preference' });

  db.uid = B; // a different account on the same database
  const b = createCloudStore(db, B);
  assert.equal((await b.listConversations()).items.length, 0);
  assert.equal(await createMemoryStore(db, B).list().then((l) => l.length), 0);
  const convA = db.tables.conversations[0].id;
  assert.equal((await b.loadMessages(convA)).messages.length, 0);
  await b.deleteConversation(convA);
  await b.renameConversation(convA, 'hacked');
  await createMemoryStore(db, B).remove(mem.id);
  assert.equal(db.tables.conversations.length, 1);
  assert.equal(db.tables.conversations[0].title, 'Guest chat 1');
  assert.equal(db.tables.user_memories.length, 1);
  assert.equal((await b.search('msg')).size, 0);
  // forged ownership is rejected by the database
  await assert.rejects(() => createCloudStore(db, A).createConversation({ id: id(9), title: 'x', titleSource: 'auto' }), /row-level security/);
  db.uid = A;
  assert.equal((await a.search('msg')).size, 1);
});

test('search finds titles and message text, scoped to the account', async () => {
  const { a } = setup();
  await a.importConversation(local(1));
  assert.equal((await a.search('guest chat 1')).size, 1);
  assert.equal((await a.search('msg 2')).size, 1);
  assert.equal((await a.search('nothing')).size, 0);
  assert.equal((await a.search('  ')).size, 0);
});

test('memory: create, edit, disable, delete, clear; credentials are refused', async () => {
  const db = new FakeSupabase();
  db.uid = A;
  const mem = createMemoryStore(db, A);
  const m1 = await mem.create({ content: '  I prefer   TypeScript\n', category: 'preference', source: 'explicit' });
  assert.equal(m1.content, 'I prefer TypeScript');
  assert.equal(m1.enabled, true);
  await mem.update(m1.id, { content: 'I prefer TypeScript and Vitest' });
  await mem.update(m1.id, { enabled: false });
  const [stored] = await mem.list();
  assert.deepEqual([stored.content, stored.enabled], ['I prefer TypeScript and Vitest', false]);
  await mem.update(m1.id, { enabled: true });
  assert.equal((await mem.list())[0].enabled, true);
  await assert.rejects(() => mem.create({ content: 'my password is hunter2' }), MemoryRejectedError);
  await assert.rejects(() => mem.create({ content: 'sk-abcdefghijklmnopqrstuvwxyz123456' }), MemoryRejectedError);
  await assert.rejects(() => mem.update(m1.id, { content: 'token: abc123' }), MemoryRejectedError);
  await assert.rejects(() => mem.create({ content: ' ' }), MemoryRejectedError);
  assert.equal((await mem.list()).length, 1);
  await mem.remove(m1.id);
  await mem.create({ content: 'note one' });
  await mem.create({ content: 'note two' });
  await mem.clearAll();
  assert.equal((await mem.list()).length, 0);
});

test('settings default to balanced depth with memory on; saving creates then updates one row', async () => {
  const db = new FakeSupabase();
  db.uid = A;
  const s = createSettingsStore(db, A);
  assert.deepEqual(await s.get(), { response_depth: 'balanced', memory_enabled: true, auto_memory: true });
  await s.save({ response_depth: 'detailed' });
  await s.save({ auto_memory: false });
  assert.equal(db.tables.user_settings.length, 1);
  assert.deepEqual(await s.get(), { response_depth: 'detailed', memory_enabled: true, auto_memory: false });
});

test('ticket client: guests send their stored token and keep a newly issued one; users send their JWT', async () => {
  const storage = new MemoryStorage();
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ ticket: 't'.repeat(30), usage: { used: 0, limit: 5, remaining: 5 }, guestToken: 'G'.repeat(30) }) };
  };
  let token = null;
  const client = createTicketClient({ ticketUrl: 'https://x.test/chat-ticket', publishableKey: 'pk', getAccessToken: async () => token, storage, fetchImpl });
  assert.equal(await client.getTicket(), 't'.repeat(30));
  assert.equal(seen[0].headers.Authorization, undefined);
  assert.equal(seen[0].body.purpose, 'ticket');
  assert.equal(storage.getItem('mitra-ai:guest-token'), 'G'.repeat(30));
  await client.status();
  assert.equal(seen[1].headers['x-guest-token'], 'G'.repeat(30));
  token = 'user-jwt';
  await client.status();
  assert.equal(seen[2].headers.Authorization, 'Bearer user-jwt');
  assert.equal(seen[2].headers['x-guest-token'], undefined);
});

test('ticket client maps failures to usable error codes', async () => {
  const mk = (response) => createTicketClient({ ticketUrl: 'u', publishableKey: 'k', getAccessToken: async () => 'jwt', storage: null,
    fetchImpl: async () => { if (response === 'network') throw new Error('offline'); return response; } });
  await assert.rejects(() => mk({ ok: false, json: async () => ({ code: 'invalid_session' }) }).getTicket(), { code: 'invalid_session' });
  await assert.rejects(() => mk({ ok: false, json: async () => ({ code: 'rate_limited' }) }).getTicket(), { code: 'rate_limited' });
  await assert.rejects(() => mk({ ok: false, json: async () => { throw new Error('bad json'); } }).getTicket(), { code: 'connect_failed' });
  await assert.rejects(() => mk('network').getTicket(), { code: 'connect_failed' });
  await assert.rejects(() => mk({ ok: true, json: async () => ({}) }).getTicket(), { code: 'connect_failed' });
});

test('auth validation and error messages do not reveal account existence', () => {
  assert.equal(validateEmail('a@b.co'), null);
  assert.ok(validateEmail('nope'));
  assert.ok(validatePassword('short1'));
  assert.ok(validatePassword('allletters'));
  assert.ok(validatePassword('12345678'));
  assert.equal(validatePassword('goodpass123'), null);
  assert.equal(friendlyAuthError({ code: 'invalid_credentials' }), 'Email or password is incorrect.');
  assert.doesNotMatch(friendlyAuthError({ code: 'user_already_exists' }), /already registered|exists/i);
  assert.match(friendlyAuthError({ code: 'email_not_confirmed' }), /confirm your email/i);
  assert.match(friendlyAuthError({ code: 'over_request_rate_limit' }), /too many/i);
  assert.match(friendlyAuthError(new Error('weird')), /something went wrong/i);
});
