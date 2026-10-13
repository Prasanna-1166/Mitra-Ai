import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeSupabase } from './fakeSupabase.js';
import { MemoryStorage, createFakeTimers } from './helpers.js';
import { ChatController } from '../src/lib/chatController.js';
import { createCloudStore } from '../src/services/conversationService.js';
import { STORAGE_KEY } from '../src/lib/storage.js';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const config = { maxMessageChars: 8000, contextMessages: 20 };
const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 6; i += 1) await tick(); };

function setup({ storage = new MemoryStorage(), db = new FakeSupabase(), usage = null, auth = [] } = {}) {
  const calls = [];
  const timers = createFakeTimers();
  const c = new ChatController({
    storage,
    createCloud: (userId) => { db.uid = userId; return createCloudStore(db, userId); },
    startRequest: (opts) => {
      const call = { opts, cancelled: false, payload: opts.payload };
      call.handle = { cancel() { call.cancelled = true; } };
      calls.push(call);
      return call.handle;
    },
    fetchUsage: async () => usage,
    config, timers, onAuthProblem: () => auth.push(1),
  });
  return { c, calls, storage, db, timers, auth };
}
const active = (c) => c.getState().sessions.find((s) => s.id === c.getState().activeSessionId);
const last = (c) => active(c).messages.at(-1);
const U = { used: 1, limit: 5, remaining: 4, resetsAt: null };
function answer(call, text = 'Answer.') {
  call.opts.onAccepted(U);
  call.opts.onChunk(text);
  call.opts.onComplete({ usage: U });
}

// ---------------------------------------------------------------- guest
test('guests: starting up creates no session and makes no AI request (no welcome call)', () => {
  const { c, calls } = setup();
  c.setIdentity(null);
  c.setIdentity(null);
  assert.equal(c.getState().kind, 'guest');
  assert.equal(c.getState().sessions.length, 0);
  assert.equal(calls.length, 0);
});

test('first question creates a titled session and sends the documented payload', () => {
  const { c, calls } = setup();
  c.setIdentity(null);
  c.setDepth('detailed');
  assert.equal(c.sendMessage('  Explain how DNS works  '), true);
  const s = active(c);
  assert.equal(s.title, 'Explain how DNS works');
  assert.deepEqual(s.messages.map((m) => [m.role, m.status ?? null]), [['user', null], ['assistant', 'pending']]);
  assert.equal(calls.length, 1);
  const p = calls[0].payload;
  assert.deepEqual(Object.keys(p).sort(), ['assistantMessageId', 'depth', 'history', 'message', 'requestId', 'userMessageId']);
  assert.equal(p.message, 'Explain how DNS works');
  assert.equal(p.depth, 'detailed');
  assert.deepEqual(p.history, []);
  assert.equal(p.userMessageId, s.messages[0].id);
  assert.equal(p.assistantMessageId, s.messages[1].id);
  assert.equal(p.conversationId, undefined);
});

test('empty, whitespace, too-long and overlapping submissions are rejected and never charged', () => {
  const { c, calls } = setup();
  c.setIdentity(null);
  assert.equal(c.sendMessage(''), false);
  assert.equal(c.sendMessage('   \n '), false);
  assert.equal(c.sendMessage('x'.repeat(8001)), false);
  assert.equal(calls.length, 0);
  assert.equal(c.sendMessage('first'), true);
  assert.equal(c.sendMessage('second'), false);
  assert.equal(calls.length, 1);
});

test('streaming fills the reply incrementally; completion needs the explicit done signal and updates usage', () => {
  const { c, calls, timers } = setup();
  c.setIdentity(null);
  c.sendMessage('hi');
  const o = calls[0].opts;
  assert.equal(c.getState().request.phase, 'connecting');
  o.onAccepted(U);
  assert.equal(c.getState().request.phase, 'generating');
  assert.equal(c.getState().usage.remaining, 4);
  o.onChunk('Hel');
  assert.deepEqual([last(c).content, last(c).status], ['Hel', 'streaming']);
  o.onChunk('lo');
  timers.advance(60);
  assert.equal(last(c).content, 'Hello');
  assert.equal(last(c).status, 'streaming', 'still streaming until done');
  o.onComplete({ usage: { ...U, used: 2, remaining: 3 } });
  assert.deepEqual([last(c).content, last(c).status], ['Hello', 'complete']);
  assert.equal(c.getState().request, null);
  assert.equal(c.getState().usage.remaining, 3);
  assert.equal(c.getState().outcome, 'complete');
});

test('later questions send only finished turns as history', () => {
  const { c, calls } = setup();
  c.setIdentity(null);
  c.sendMessage('Q1'); answer(calls[0], 'A1');
  c.sendMessage('Q2'); calls[1].opts.onChunk('part'); calls[1].opts.onError({ code: 'interrupted', message: 'lost', messageSent: true });
  c.retryMessage(last(c).id);
  c.sendMessage('ignored while generating');
  calls[2].opts.onChunk('A2'); calls[2].opts.onComplete({});
  c.sendMessage('Q3');
  assert.deepEqual(calls[3].payload.history, [
    { role: 'user', content: 'Q1' }, { role: 'assistant', content: 'A1' },
    { role: 'user', content: 'Q2' }, { role: 'assistant', content: 'A2' },
  ]);
});

test('stopping keeps partial text as "stopped", cancels the transport, and stale callbacks do nothing', () => {
  const { c, calls } = setup();
  c.setIdentity(null);
  c.sendMessage('go');
  calls[0].opts.onChunk('abc');
  c.stopGeneration();
  assert.equal(calls[0].cancelled, true);
  assert.deepEqual([last(c).status, last(c).content], ['stopped', 'abc']);
  const snap = c.getState();
  calls[0].opts.onChunk('LATE');
  calls[0].opts.onComplete({});
  calls[0].opts.onError({ code: 'x', message: 'x' });
  assert.equal(c.getState(), snap);
});

test('a failure leaves an explained error bubble; Retry resends the same text without duplicating the question', () => {
  const { c, calls } = setup();
  c.setIdentity(null);
  c.sendMessage('Tell me a joke');
  const userId = active(c).messages[0].id;
  calls[0].opts.onError({ code: 'connect_failed', message: "Couldn't connect.", messageSent: false });
  assert.deepEqual([last(c).status, last(c).error], ['error', "Couldn't connect."]);
  assert.equal(c.getState().request, null);
  assert.equal(c.retryMessage(last(c).id), true);
  assert.equal(calls[1].payload.message, 'Tell me a joke');
  assert.equal(calls[1].payload.userMessageId, userId, 'the question keeps its id (idempotent save)');
  assert.notEqual(calls[1].payload.requestId, calls[0].payload.requestId, 'a new request id for the new attempt');
  answer(calls[1]);
  assert.equal(active(c).messages.filter((m) => m.role === 'user').length, 1);
  assert.equal(last(c).status, 'complete');
  // the latest completed reply can be regenerated; the question is still not duplicated
  assert.equal(c.retryMessage(last(c).id), true);
  assert.equal(calls[2].payload.userMessageId, userId);
  assert.equal(active(c).messages.filter((m) => m.role === 'user').length, 1);
  assert.equal(active(c).messages.length, 2, 'the old reply is replaced, not appended to');
  c.stopGeneration();
  assert.equal(c.retryMessage('not-a-message'), false);
});

test('failure after partial text keeps the text, flags it incomplete and records messageSent', () => {
  const { c, calls } = setup();
  c.setIdentity(null);
  c.sendMessage('q');
  calls[0].opts.onChunk('Half');
  calls[0].opts.onError({ code: 'interrupted', message: 'Connection lost.', messageSent: true, hasPartial: true });
  assert.deepEqual([last(c).status, last(c).content, last(c).messageSent], ['error', 'Half', true]);
});

test('guest limit: the rejected question is rolled back, handed back, and nothing else is lost', () => {
  const { c, calls, storage } = setup();
  c.setIdentity(null);
  c.sendMessage('Q1'); answer(calls[0], 'A1');
  c.sendMessage('Q6 blocked');
  calls[1].opts.onError({ code: 'quota_exceeded', message: 'Used up.', usage: { used: 5, limit: 5, remaining: 0 }, retryable: false });
  assert.deepEqual(active(c).messages.map((m) => m.content), ['Q1', 'A1'], 'earlier conversation is intact');
  assert.equal(c.getState().request, null);
  assert.deepEqual(c.getState().limit, { kind: 'guest', usage: { used: 5, limit: 5, remaining: 0 }, restoredText: 'Q6 blocked' });
  assert.equal(c.getState().usage.remaining, 0);
  assert.ok(!storage.getItem(STORAGE_KEY).includes('Q6 blocked'));
  c.dismissLimit();
  assert.equal(c.getState().limit, null);
});

test('guest limit on the very first question leaves no empty session behind', () => {
  const { c, calls } = setup();
  c.setIdentity(null);
  c.sendMessage('first ever');
  calls[0].opts.onError({ code: 'quota_exceeded', message: 'x', usage: { remaining: 0 } });
  assert.equal(c.getState().sessions.length, 0);
  assert.equal(c.getState().activeSessionId, null);
  assert.equal(c.getState().limit.restoredText, 'first ever');
});

test('switching, new chat and delete while generating stop the request and ignore late events', () => {
  const { c, calls } = setup();
  c.setIdentity(null);
  c.sendMessage('one'); answer(calls[0], 'A');
  const firstId = c.getState().activeSessionId;
  c.newChat();
  assert.equal(c.getState().activeSessionId, null);
  c.sendMessage('two');
  const secondId = c.getState().activeSessionId;
  calls[1].opts.onChunk('typing');
  c.switchSession(firstId);
  assert.equal(calls[1].cancelled, true);
  assert.equal(c.getState().request, null);
  const second = c.getState().sessions.find((s) => s.id === secondId);
  assert.deepEqual([second.messages.at(-1).status, second.messages.at(-1).content], ['stopped', 'typing']);
  const snap = c.getState();
  calls[1].opts.onChunk('LATE');
  assert.equal(c.getState(), snap);

  c.sendMessage('three');
  calls[2].opts.onChunk('x');
  c.deleteSession(firstId);
  assert.equal(calls[2].cancelled, true);
  assert.equal(c.getState().request, null);
  const snap2 = c.getState();
  calls[2].opts.onChunk('ghost');
  calls[2].opts.onComplete({});
  assert.equal(c.getState(), snap2);
  assert.ok(!JSON.stringify(c.getState().sessions).includes('ghost'));
});

test('clear, rename, delete and delete-all update memory and storage consistently', () => {
  const { c, calls, storage } = setup();
  c.setIdentity(null);
  c.sendMessage('Explain DNS'); answer(calls[0]);
  const id = c.getState().activeSessionId;
  assert.equal(c.renameSession(id, '  My   DNS notes '), true);
  assert.equal(c.renameSession(id, '   '), false);
  c.clearSession();
  assert.deepEqual([active(c).messages.length, active(c).title], [0, 'My DNS notes']);
  c.sendMessage('Second chat?'); answer(calls[1]);
  c.newChat();
  c.sendMessage('Third chat'); answer(calls[2]);
  assert.equal(c.getState().sessions.length, 2);
  c.deleteSession(c.getState().activeSessionId);
  assert.equal(c.getState().sessions.length, 1);
  assert.equal(c.getState().activeSessionId, null);
  assert.ok(storage.getItem(STORAGE_KEY));
  c.deleteAll();
  assert.equal(c.getState().sessions.length, 0);
  assert.equal(storage.getItem(STORAGE_KEY), null);
  assert.equal(c.sendMessage('still usable'), true);
});

test('guest history survives a reload; corrupted storage starts clean', () => {
  const a = setup();
  a.c.setIdentity(null);
  a.c.sendMessage('Hello there'); answer(a.calls[0], 'Hi!');
  a.c.flush();
  const b = setup({ storage: a.storage });
  b.c.setIdentity(null);
  assert.deepEqual(b.c.getState().sessions[0].messages.map((m) => m.content), ['Hello there', 'Hi!']);
  assert.equal(b.c.getState().sessions[0].title, 'Hello there');
  assert.equal(b.calls.length, 0, 'restoring history makes no AI request');

  const bad = setup({ storage: new MemoryStorage({ [STORAGE_KEY]: '{oops' }) });
  bad.c.setIdentity(null);
  assert.equal(bad.c.getState().sessions.length, 0);
  assert.ok(bad.c.getState().storageWarning);
  assert.equal(bad.c.sendMessage('works'), true);
});

test('streaming does not write storage for every chunk', () => {
  const { c, calls, storage, timers } = setup();
  c.setIdentity(null);
  c.sendMessage('go');
  const before = storage.writes;
  for (let i = 0; i < 200; i += 1) calls[0].opts.onChunk(`w${i} `);
  assert.ok(storage.writes - before <= 1);
  timers.advance(60);
  assert.ok(last(c).content.endsWith('w199 '));
  timers.advance(700);
  calls[0].opts.onComplete({});
  assert.ok(last(c).content.startsWith('w0 w1'));
});

test('an expired session reported by the server notifies the app', () => {
  const { c, calls, auth } = setup();
  c.setIdentity(null);
  c.sendMessage('q');
  calls[0].opts.onError({ code: 'session_expired', message: 'Session expired.' });
  assert.equal(auth.length, 1);
  assert.equal(last(c).status, 'error');
});

test('usage is fetched for the identity and stale results from a previous identity are dropped', async () => {
  const slow = [];
  const c = new ChatController({
    storage: new MemoryStorage(), createCloud: () => null, startRequest: () => ({ cancel() {} }), config,
    fetchUsage: () => new Promise((r) => slow.push(r)),
  });
  c.setIdentity(null);
  c.setIdentity(null); // idempotent: no second fetch
  assert.equal(slow.length, 1);
  c.setIdentity(null);
  slow[0]({ usage: { used: 1, limit: 5, remaining: 4 } });
  await tick();
  assert.equal(c.getState().usage.remaining, 4);
});

// ---------------------------------------------------------------- signed in
async function signedIn(opts) {
  const ctx = setup(opts);
  ctx.c.setIdentity(A);
  await settle();
  return ctx;
}
async function sendCloud(ctx, text) {
  assert.equal(ctx.c.sendMessage(text), true);
  await settle();
  return ctx.calls.at(-1);
}

test('signed-in: the saved conversation list loads without messages, messages load on selection, newest page first', async () => {
  const db = new FakeSupabase();
  db.uid = A;
  const store = createCloudStore(db, A);
  await store.createConversation({ id: '11111111-1111-4111-8111-000000000001', title: 'Saved chat', titleSource: 'auto' });
  for (let i = 0; i < 60; i += 1) {
    db.tables.messages.push({ id: `22222222-2222-4222-8222-${String(i).padStart(12, '0')}`, seq: ++db.seq, conversation_id: '11111111-1111-4111-8111-000000000001', user_id: A, client_id: `33333333-3333-4333-8333-${String(i).padStart(12, '0')}`, role: i % 2 ? 'assistant' : 'user', content: `m${i}`, status: 'complete', error: null, created_at: db.now() });
  }
  const { c } = await signedIn({ db });
  assert.equal(c.getState().kind, 'user');
  assert.equal(c.getState().sessions.length, 1);
  assert.equal(c.getState().sessions[0].messagesLoaded, false);
  c.switchSession('11111111-1111-4111-8111-000000000001');
  await settle();
  const s = active(c);
  assert.equal(s.messages.length, 50, 'a bounded page, not the whole history');
  assert.equal(s.messages.at(-1).content, 'm59');
  assert.equal(s.hasMoreMessages, true);
  c.loadOlderMessages();
  await settle();
  assert.equal(active(c).messages.length, 60);
  assert.equal(active(c).messages[0].content, 'm0');
  assert.equal(new Set(active(c).messages.map((m) => m.id)).size, 60);
});

test('signed-in: the conversation row is created before the request; the payload has no client-supplied history', async () => {
  const ctx = await signedIn();
  assert.equal(ctx.c.sendMessage('Explain Vite'), true);
  assert.equal(ctx.calls.length, 0, 'not sent until the conversation exists');
  await settle();
  assert.equal(ctx.calls.length, 1);
  const p = ctx.calls[0].payload;
  assert.equal(p.conversationId, active(ctx.c).id);
  assert.equal(p.history, undefined);
  assert.equal(ctx.db.tables.conversations.length, 1);
  assert.equal(ctx.db.tables.conversations[0].title, 'Explain Vite');
  assert.equal(ctx.db.tables.conversations[0].user_id, A);
  answer(ctx.calls[0]);
  assert.equal(last(ctx.c).status, 'complete');
});

test('signed-in: stopping while the conversation is still being created sends nothing', async () => {
  const ctx = await signedIn();
  ctx.c.sendMessage('quick');
  ctx.c.stopGeneration();
  await settle();
  assert.equal(ctx.calls.length, 0);
  assert.equal(last(ctx.c).status, 'stopped');
});

test('signed-in: a failure to save the conversation is reported instead of silently sending', async () => {
  const ctx = await signedIn();
  ctx.db.failNext = { table: 'conversations', op: 'insert' };
  ctx.c.sendMessage('hello');
  await settle();
  assert.equal(ctx.calls.length, 0);
  assert.equal(last(ctx.c).status, 'error');
  assert.match(last(ctx.c).error, /couldn't be saved/);
});

test('signed-in: quota rejection on a brand-new conversation removes the empty cloud row', async () => {
  const ctx = await signedIn();
  const call = await sendCloud(ctx, 'over the limit');
  call.opts.onError({ code: 'quota_exceeded', message: 'x', usage: { used: 100, limit: 100, remaining: 0, resetsAt: '2026-10-12T00:00:00.000Z' } });
  await settle();
  assert.equal(ctx.c.getState().limit.kind, 'user');
  assert.equal(ctx.c.getState().sessions.length, 0);
  assert.equal(ctx.db.tables.conversations.length, 0);
});

test('signed-in: retry replaces the failed reply in the database and keeps one copy of the question', async () => {
  const ctx = await signedIn();
  const call = await sendCloud(ctx, 'Retry me');
  const sessionId = active(ctx.c).id;
  const userId = active(ctx.c).messages[0].id;
  const assistantId = last(ctx.c).id;
  // simulate what the relay saved
  ctx.db.tables.messages.push(
    { id: 'a1', seq: ++ctx.db.seq, conversation_id: sessionId, user_id: A, client_id: userId, role: 'user', content: 'Retry me', status: 'complete', created_at: ctx.db.now() },
    { id: 'a2', seq: ++ctx.db.seq, conversation_id: sessionId, user_id: A, client_id: assistantId, role: 'assistant', content: '', status: 'error', error: 'x', created_at: ctx.db.now() },
  );
  call.opts.onError({ code: 'upstream_failed', message: 'Provider failed.', messageSent: true });
  assert.equal(ctx.c.retryMessage(last(ctx.c).id), true);
  await settle();
  assert.equal(ctx.db.tables.messages.filter((m) => m.client_id === assistantId).length, 0, 'failed attempt removed');
  assert.equal(ctx.db.tables.messages.filter((m) => m.client_id === userId).length, 1);
  assert.equal(ctx.calls.at(-1).payload.userMessageId, userId);
});

test('signed-in: delete is rolled back with a notice when the server refuses; success removes the row', async () => {
  const ctx = await signedIn();
  const call = await sendCloud(ctx, 'to delete'); answer(call);
  const id = active(ctx.c).id;
  ctx.db.failNext = { table: 'conversations', op: 'delete' };
  ctx.c.deleteSession(id);
  assert.equal(ctx.c.getState().sessions.length, 0, 'optimistic');
  await settle();
  assert.equal(ctx.c.getState().sessions.length, 1, 'restored after failure');
  assert.match(ctx.c.getState().notice.text, /couldn't be deleted/);
  ctx.c.dismissNotice();
  ctx.c.deleteSession(id);
  await settle();
  assert.equal(ctx.db.tables.conversations.length, 0);
});

test('signed-in: clearing a conversation and deleting everything reach the database', async () => {
  const ctx = await signedIn();
  const call = await sendCloud(ctx, 'one'); answer(call);
  const sid = active(ctx.c).id;
  ctx.db.tables.messages.push({ id: 'm', seq: ++ctx.db.seq, conversation_id: sid, user_id: A, client_id: null, role: 'user', content: 'x', status: 'complete', created_at: ctx.db.now() });
  ctx.c.clearSession();
  await settle();
  assert.equal(ctx.db.tables.messages.length, 0);
  assert.equal(ctx.db.tables.conversations.length, 1);
  ctx.c.deleteAll();
  await settle();
  assert.equal(ctx.db.tables.conversations.length, 0);
  assert.equal(ctx.c.getState().sessions.length, 0);
});

test('a conversation that is still loading cannot receive a message', async () => {
  const db = new FakeSupabase();
  db.uid = A;
  await createCloudStore(db, A).createConversation({ id: '11111111-1111-4111-8111-000000000001', title: 'Old', titleSource: 'auto' });
  const { c } = await signedIn({ db });
  c.switchSession('11111111-1111-4111-8111-000000000001');
  assert.equal(c.sendMessage('too early'), false);
  await settle();
  assert.equal(c.sendMessage('now fine'), true);
});

test('account switching: the next account never sees the previous one\'s chats, and late results are discarded', async () => {
  const db = new FakeSupabase();
  db.uid = A;
  await createCloudStore(db, A).createConversation({ id: '11111111-1111-4111-8111-000000000001', title: 'A private chat', titleSource: 'auto' });
  const slowLists = [];
  const c = new ChatController({
    storage: new MemoryStorage(), config, startRequest: () => ({ cancel() {} }),
    createCloud: (userId) => {
      const real = createCloudStore(db, userId);
      return { ...real, listConversations: (args) => new Promise((resolve) => slowLists.push(() => { db.uid = userId; real.listConversations(args).then(resolve); })) };
    },
  });
  c.setIdentity(A);
  c.setIdentity(B); // A signs out and B signs in before A's list returns
  assert.equal(c.getState().sessions.length, 0);
  slowLists[0](); // A's late response
  await settle();
  assert.equal(c.getState().sessions.length, 0, 'A\'s late result is discarded');
  assert.equal(c.getState().userId, B);
  slowLists[1]();
  await settle();
  assert.equal(c.getState().sessions.length, 0, 'B has no chats');
  assert.ok(!JSON.stringify(c.getState()).includes('A private chat'));
});

test('guest -> user -> guest: cloud mode never writes guest storage; returning to guest restores only local chats', async () => {
  const storage = new MemoryStorage();
  const ctx = setup({ storage });
  ctx.c.setIdentity(null);
  ctx.c.sendMessage('local question'); answer(ctx.calls[0], 'local answer');
  ctx.c.setIdentity(A);
  await settle();
  assert.equal(ctx.c.getState().sessions.length, 0, 'guest chats are not shown inside the account');
  const call = await sendCloud(ctx, 'cloud question'); answer(call);
  const stored = storage.getItem(STORAGE_KEY);
  assert.ok(stored.includes('local question') && !stored.includes('cloud question'));
  ctx.c.setIdentity(null);
  assert.deepEqual(ctx.c.getState().sessions.map((s) => s.title), ['local question']);
});

test('in-flight request is cancelled when the identity changes', async () => {
  const ctx = await signedIn();
  const call = await sendCloud(ctx, 'pending');
  ctx.c.setIdentity(null);
  assert.equal(call.cancelled, true);
  assert.equal(ctx.c.getState().request, null);
  const snap = ctx.c.getState();
  call.opts.onChunk('late');
  assert.equal(ctx.c.getState(), snap);
});

test('cloud search returns matching conversation ids; guests have none', async () => {
  const ctx = await signedIn();
  const call = await sendCloud(ctx, 'Kubernetes basics'); answer(call);
  assert.equal((await ctx.c.searchCloud('kubernetes')).size, 1);
  ctx.c.setIdentity(null);
  assert.equal(await ctx.c.searchCloud('x'), null);
});

test('export loads every page of a long cloud conversation', async () => {
  const db = new FakeSupabase();
  db.uid = A;
  const cid = '11111111-1111-4111-8111-000000000001';
  await createCloudStore(db, A).createConversation({ id: cid, title: 'Long', titleSource: 'auto' });
  for (let i = 0; i < 120; i += 1) db.tables.messages.push({ id: `22222222-2222-4222-8222-${String(i).padStart(12, '0')}`, seq: ++db.seq, conversation_id: cid, user_id: A, client_id: null, role: 'user', content: `m${i}`, status: 'complete', created_at: db.now() });
  const { c } = await signedIn({ db });
  c.switchSession(cid);
  await settle();
  const exported = await c.exportMessages(cid);
  assert.equal(exported.messages.length, 120);
  assert.equal(exported.messages[0].content, 'm0');
});
