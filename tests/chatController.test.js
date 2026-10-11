import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { FakeWebSocket, MemoryStorage, createFakeTimers, testConfig } from './helpers.js';
import { ChatController } from '../src/lib/chatController.js';
import { STORAGE_KEY } from '../src/lib/storage.js';

beforeEach(() => {
  FakeWebSocket.reset();
  FakeWebSocket.throwOnConstruct = false;
});

function setup({ storage = new MemoryStorage() } = {}) {
  const timers = createFakeTimers();
  const c = new ChatController({ storage, WebSocketImpl: FakeWebSocket, config: testConfig, timers });
  return { c, storage, timers, sockets: () => FakeWebSocket.instances };
}
const active = (c) => c.getState().sessions.find((s) => s.id === c.getState().activeSessionId);
const lastMsg = (c) => active(c).messages.at(-1);

// Start a controller whose greeting has completed.
function ready(opts) {
  const ctx = setup(opts);
  ctx.c.start();
  const ws = FakeWebSocket.last;
  ws.open();
  ws.message('Hello! I am Mitra AI.');
  ws.serverClose(1000);
  return ctx;
}
// Send a message and complete the reply.
function converse(c, text, reply = 'Sure.') {
  assert.equal(c.sendMessage(text), true);
  const ws = FakeWebSocket.last;
  ws.open();
  ws.message(reply);
  ws.serverClose(1000);
}

// ---------- initialisation ----------
test('start() creates exactly one session and one connection with the provider payload', () => {
  const { c, sockets } = setup();
  c.start();
  c.start(); // calling again must be harmless
  assert.equal(c.getState().sessions.length, 1);
  assert.equal(sockets().length, 1);
  const ws = sockets()[0];
  assert.equal(ws.url, testConfig.wsUrl);
  ws.open();
  assert.deepEqual(ws.sent, [{
    chatId: active(c).chatId,
    appId: 'test-app',
    systemPrompt: 'test prompt',
    message: 'WELCOME',
  }]);
});

test('the greeting appears once, is not duplicated, and is complete after the close', () => {
  const { c } = ready();
  const msgs = active(c).messages;
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].content, 'Hello! I am Mitra AI.');
  assert.equal(msgs[0].status, 'complete');
  assert.equal(c.getState().request, null);
  c.start();
  assert.equal(FakeWebSocket.instances.length, 1);
});

test('React StrictMode (start, stop, start) sends exactly one greeting and creates one session', () => {
  const { c, sockets } = setup();
  c.start();
  c.stop();
  c.start();
  assert.equal(c.getState().sessions.length, 1);
  assert.equal(sockets().length, 2);
  assert.equal(sockets()[0].readyState, 3, 'the first socket was closed before it opened');
  sockets()[0].open(); // late event from the closed socket is ignored
  assert.equal(sockets()[0].sent.length, 0);
  sockets()[1].open();
  sockets()[1].message('Hi');
  sockets()[1].serverClose(1000);
  const sentTotal = sockets().reduce((n, s) => n + s.sent.length, 0);
  assert.equal(sentTotal, 1);
  assert.equal(active(c).messages.length, 1);
});

test('a restored chat does not open a connection on start', () => {
  const first = ready();
  converse(first.c, 'Hello there');
  first.c.flush();
  FakeWebSocket.reset();
  const second = setup({ storage: first.storage });
  second.c.start();
  assert.equal(FakeWebSocket.instances.length, 0);
  assert.equal(second.c.getState().sessions.length, 1);
});

// ---------- titles, new chat, isolation ----------
test('the first meaningful user message names the chat; meaningless input does not', () => {
  const { c } = ready();
  assert.equal(active(c).title, 'New chat');
  converse(c, '??');
  assert.equal(active(c).title, 'New chat');
  converse(c, '  Explain how DNS works  ');
  assert.equal(active(c).title, 'Explain how DNS works');
  converse(c, 'Something else entirely');
  assert.equal(active(c).title, 'Explain how DNS works');
});

test('new chat does nothing while the current chat is untouched, otherwise creates one session and one socket', () => {
  const { c, sockets } = ready();
  assert.equal(c.newChat(), false);
  assert.equal(c.getState().sessions.length, 1);
  converse(c, 'Hello there');
  const before = sockets().length;
  assert.equal(c.newChat(), true);
  assert.equal(c.getState().sessions.length, 2);
  assert.equal(sockets().length, before + 1);
  assert.equal(FakeWebSocket.last.url, testConfig.wsUrl);
  FakeWebSocket.last.open();
  assert.equal(FakeWebSocket.last.sent[0].message, 'WELCOME');
  const [a, b] = c.getState().sessions;
  assert.notEqual(a.chatId, b.chatId);
});

test('sessions never show another session\'s response, and late events from an old socket are ignored', () => {
  const { c } = ready();
  const firstId = c.getState().activeSessionId;
  assert.equal(c.sendMessage('Question one'), true);
  const oldSocket = FakeWebSocket.last;
  oldSocket.open();
  oldSocket.message('partial answer');

  c.newChat(); // switching policy: the running generation is cancelled
  const secondId = c.getState().activeSessionId;
  assert.notEqual(firstId, secondId);
  const newSocket = FakeWebSocket.last;
  assert.notEqual(oldSocket, newSocket);

  const snapshot = c.getState();
  oldSocket.message('LATE CHUNK');
  oldSocket.error();
  oldSocket.serverClose(1000); // old socket closes AFTER the new request exists
  assert.equal(c.getState(), snapshot, 'stale events changed nothing');
  assert.ok(c.getState().request, 'the newer request is still loading');
  assert.equal(c.getState().request.sessionId, secondId);

  const first = c.getState().sessions.find((s) => s.id === firstId);
  assert.equal(first.messages.at(-1).content, 'partial answer');
  assert.equal(first.messages.at(-1).status, 'stopped');

  newSocket.open();
  newSocket.message('Fresh greeting');
  newSocket.serverClose(1000);
  const second = c.getState().sessions.find((s) => s.id === secondId);
  assert.deepEqual(second.messages.map((m) => m.content), ['Fresh greeting']);
  assert.equal(c.getState().request, null);
});

test('switching chats while generating stops the generation and keeps the partial text', () => {
  const { c } = ready();
  const firstId = c.getState().activeSessionId;
  converse(c, 'one');
  c.newChat();
  FakeWebSocket.last.open();
  FakeWebSocket.last.message('hello');
  FakeWebSocket.last.serverClose(1000);
  assert.equal(c.sendMessage('two'), true);
  FakeWebSocket.last.open();
  FakeWebSocket.last.message('half');
  c.switchSession(firstId);
  assert.equal(c.getState().request, null);
  assert.equal(c.getState().activeSessionId, firstId);
  const other = c.getState().sessions.find((s) => s.id !== firstId);
  assert.equal(other.messages.at(-1).status, 'stopped');
  assert.equal(other.messages.at(-1).content, 'half');
});

// ---------- overlap, stop ----------
test('a second send while a request is running is rejected and opens no second socket', () => {
  const { c, sockets } = ready();
  assert.equal(c.sendMessage('first'), true);
  const count = sockets().length;
  assert.equal(c.sendMessage('second'), false);
  assert.equal(sockets().length, count);
  assert.equal(active(c).messages.filter((m) => m.role === 'user').length, 1);
  assert.equal(c.sendMessage('   '), false);
});

test('stopping keeps partial text as "stopped", closes the socket, and ignores late events', () => {
  const { c } = ready();
  c.sendMessage('long question');
  const ws = FakeWebSocket.last;
  ws.open();
  ws.message('abc');
  c.stopGeneration();
  assert.equal(ws.closeCode, 1000);
  assert.equal(c.getState().request, null);
  assert.deepEqual([lastMsg(c).status, lastMsg(c).content], ['stopped', 'abc']);
  const snap = c.getState();
  ws.message('more');
  ws.serverClose(1006);
  assert.equal(c.getState(), snap);
  assert.equal(c.getState().outcome, 'stopped');
});

test('stopping before any text leaves an explained (not blank) stopped bubble', () => {
  const { c } = ready();
  c.sendMessage('hi');
  c.stopGeneration();
  assert.equal(lastMsg(c).status, 'stopped');
  assert.equal(lastMsg(c).content, '');
});

// ---------- failures ----------
test('a connection failure marks the reply as failed; Retry resends without duplicating the user message', () => {
  const { c } = ready();
  c.sendMessage('Tell me a joke');
  const chatId = active(c).chatId;
  FakeWebSocket.last.error(); // never opened
  const failed = lastMsg(c);
  assert.equal(failed.status, 'error');
  assert.match(failed.error, /connect/i);
  assert.equal(failed.messageSent, undefined);
  assert.equal(c.getState().request, null);
  assert.equal(c.getState().outcome, 'error');

  assert.equal(c.retryMessage(failed.id), true);
  const retry = FakeWebSocket.last;
  retry.open();
  assert.deepEqual(retry.sent[0].message, 'Tell me a joke');
  assert.equal(retry.sent[0].chatId, chatId);
  retry.message('Why did the...');
  retry.serverClose(1000);
  const msgs = active(c).messages;
  assert.equal(msgs.filter((m) => m.role === 'user' && m.content === 'Tell me a joke').length, 1);
  assert.equal(msgs.at(-1).status, 'complete');
  assert.equal(msgs.filter((m) => m.status === 'error').length, 0);
});

test('failure after partial text keeps the text, flags it as incomplete and records that the message was sent', () => {
  const { c } = ready();
  c.sendMessage('q');
  const ws = FakeWebSocket.last;
  ws.open();
  ws.message('Partial ans');
  ws.serverClose(1006);
  assert.deepEqual([lastMsg(c).status, lastMsg(c).content, lastMsg(c).messageSent], ['error', 'Partial ans', true]);
  assert.match(lastMsg(c).error, /lost|finished/i);
  assert.equal(c.getState().request, null);
});

test('closing with 1000 and no text is an error, never a silent blank reply', () => {
  const { c } = ready();
  c.sendMessage('q');
  FakeWebSocket.last.open();
  FakeWebSocket.last.serverClose(1000);
  assert.equal(lastMsg(c).status, 'error');
  assert.match(lastMsg(c).error, /without sending/i);
});

test('a connection that never opens times out and the app is not left loading', () => {
  const { c, timers } = ready();
  c.sendMessage('q');
  const ws = FakeWebSocket.last;
  timers.advance(testConfig.connectTimeoutMs);
  assert.equal(c.getState().request, null);
  assert.equal(lastMsg(c).status, 'error');
  assert.match(lastMsg(c).error, /too long/i);
  assert.equal(ws.closeCode, 1000);
});

test('a provider that goes silent mid-answer times out with the partial text preserved', () => {
  const { c, timers } = ready();
  c.sendMessage('q');
  FakeWebSocket.last.open();
  FakeWebSocket.last.message('so far');
  timers.advance(testConfig.idleTimeoutMs);
  assert.deepEqual([lastMsg(c).status, lastMsg(c).content], ['error', 'so far']);
  assert.equal(c.getState().request, null);
});

test('a failed greeting shows a recoverable notice instead of a blank bubble; retry works', () => {
  const { c } = setup();
  c.start();
  const id = c.getState().activeSessionId;
  FakeWebSocket.last.error();
  assert.equal(active(c).messages.length, 0);
  assert.ok(c.getState().welcomeErrors[id]);
  assert.equal(c.retryWelcome(), true);
  assert.equal(c.getState().welcomeErrors[id], undefined);
  FakeWebSocket.last.open();
  FakeWebSocket.last.message('Hi!');
  FakeWebSocket.last.serverClose(1000);
  assert.equal(active(c).messages.length, 1);
});

test('the user can still send a message after the greeting failed', () => {
  const { c } = setup();
  c.start();
  FakeWebSocket.last.error();
  assert.equal(c.sendMessage('hello'), true);
  assert.equal(c.getState().welcomeErrors[active(c).id], undefined);
  assert.equal(active(c).messages.at(-1).status, 'pending');
});

// ---------- delete / clear ----------
test('deleting the active chat during generation cancels it; late events change nothing', () => {
  const { c } = ready();
  const firstId = c.getState().activeSessionId;
  converse(c, 'one');
  c.newChat();
  FakeWebSocket.last.open();
  FakeWebSocket.last.message('hello');
  FakeWebSocket.last.serverClose(1000);
  const secondId = c.getState().activeSessionId;
  c.sendMessage('two');
  const ws = FakeWebSocket.last;
  ws.open();
  ws.message('typing');

  c.deleteSession(secondId);
  assert.equal(c.getState().request, null);
  assert.equal(c.getState().activeSessionId, firstId);
  assert.equal(c.getState().sessions.length, 1);
  const snap = c.getState();
  ws.message('ghost');
  ws.serverClose(1000);
  assert.equal(c.getState(), snap);
  assert.ok(!JSON.stringify(c.getState().sessions).includes('ghost'));
});

test('deleting the only chat leaves a fresh usable chat with its own greeting request', () => {
  const { c } = ready();
  const oldId = c.getState().activeSessionId;
  c.deleteSession(oldId);
  assert.equal(c.getState().sessions.length, 1);
  assert.notEqual(c.getState().activeSessionId, oldId);
  assert.ok(c.getState().request);
  FakeWebSocket.last.open();
  FakeWebSocket.last.message('Hi');
  FakeWebSocket.last.serverClose(1000);
  assert.equal(c.sendMessage('works'), true);
});

test('deleting an unknown chat is a no-op', () => {
  const { c } = ready();
  const snap = c.getState();
  c.deleteSession('nope');
  assert.equal(c.getState(), snap);
});

test('clearing a conversation empties it, resets an automatic title, uses a new provider chatId and asks for a new greeting', () => {
  const { c } = ready();
  converse(c, 'Explain DNS');
  const before = active(c);
  c.clearSession();
  const after = active(c);
  assert.equal(after.id, before.id);
  assert.notEqual(after.chatId, before.chatId);
  assert.equal(after.messages.length, 0);
  assert.equal(after.title, 'New chat');
  assert.ok(c.getState().request);
  FakeWebSocket.last.open();
  assert.equal(FakeWebSocket.last.sent[0].chatId, after.chatId);
});

test('clearing keeps a title the user chose', () => {
  const { c } = ready();
  converse(c, 'Explain DNS');
  c.renameSession(c.getState().activeSessionId, 'My notes');
  c.clearSession();
  assert.equal(active(c).title, 'My notes');
});

test('renaming validates input and marks the title as user-chosen (not overwritten later)', () => {
  const { c } = ready();
  const id = c.getState().activeSessionId;
  assert.equal(c.renameSession(id, '   '), false);
  assert.equal(c.renameSession(id, '  Project   X '), true);
  assert.equal(active(c).title, 'Project X');
  converse(c, 'A different first message');
  assert.equal(active(c).title, 'Project X');
});

test('delete all clears storage and leaves one clean, usable chat', () => {
  const { c, storage } = ready();
  converse(c, 'one');
  c.newChat();
  FakeWebSocket.last.open();
  FakeWebSocket.last.message('hi');
  FakeWebSocket.last.serverClose(1000);
  converse(c, 'two');
  assert.ok(storage.getItem(STORAGE_KEY));
  c.deleteAll();
  assert.equal(storage.getItem(STORAGE_KEY), null);
  const s = c.getState();
  assert.equal(s.sessions.length, 1);
  assert.equal(s.sessions[0].messages.length, 0);
  assert.equal(s.activeSessionId, s.sessions[0].id);
  FakeWebSocket.last.open();
  FakeWebSocket.last.message('Hi');
  FakeWebSocket.last.serverClose(1000);
  assert.equal(c.sendMessage('still works'), true);
});

test('sending with no chat at all creates one and sends without a greeting', () => {
  const { c } = setup();
  assert.equal(c.sendMessage('hello'), true);
  assert.equal(c.getState().sessions.length, 1);
  FakeWebSocket.last.open();
  assert.equal(FakeWebSocket.last.sent[0].message, 'hello');
  assert.equal(FakeWebSocket.instances.length, 1);
});

// ---------- persistence ----------
test('history survives a reload: sessions, order, titles, ids, timestamps, active chat', () => {
  const a = ready();
  converse(a.c, 'Explain DNS', 'DNS maps names to IPs.');
  a.c.newChat();
  FakeWebSocket.last.open();
  FakeWebSocket.last.message('Hi again');
  FakeWebSocket.last.serverClose(1000);
  converse(a.c, 'Second topic');
  a.c.flush();
  const saved = a.c.getState();

  const b = setup({ storage: a.storage });
  const restored = b.c.getState();
  assert.equal(restored.activeSessionId, saved.activeSessionId);
  assert.deepEqual(
    restored.sessions.map((s) => [s.id, s.chatId, s.title, s.messages.map((m) => [m.id, m.role, m.content, m.timestamp, m.status ?? null])]),
    saved.sessions.map((s) => [s.id, s.chatId, s.title, s.messages.map((m) => [m.id, m.role, m.content, m.timestamp, m.status ?? null])]),
  );
});

test('corrupted saved history starts clean instead of crashing', () => {
  for (const text of ['{oops', '{"version":1,"sessions":[{"id":1}]}', 'null']) {
    FakeWebSocket.reset();
    const storage = new MemoryStorage({ [STORAGE_KEY]: text });
    const { c } = setup({ storage });
    c.start();
    assert.equal(c.getState().sessions.length, 1, text);
    assert.equal(FakeWebSocket.instances.length, 1);
  }
  const { c } = setup({ storage: new MemoryStorage({ [STORAGE_KEY]: '{oops' }) });
  assert.ok(c.getState().storageWarning);
});

test('streaming does not write to storage for every chunk', () => {
  const { c, storage, timers } = ready();
  c.sendMessage('go');
  const ws = FakeWebSocket.last;
  ws.open();
  const before = storage.writes;
  for (let i = 0; i < 200; i += 1) ws.message(`w${i} `);
  assert.ok(storage.writes - before <= 1, `writes during streaming: ${storage.writes - before}`);
  timers.advance(60); // the render batch flushes
  assert.ok(lastMsg(c).content.endsWith('w199 '));
  timers.advance(700); // the throttled save lands
  assert.ok(storage.writes - before <= 3);
  ws.serverClose(1000);
  assert.equal(lastMsg(c).status, 'complete');
  assert.ok(lastMsg(c).content.startsWith('w0 w1 '));
  assert.ok(lastMsg(c).content.endsWith('w199 '));
});

test('a partial answer is saved and restored as incomplete, not as a finished response', () => {
  const a = ready();
  a.c.sendMessage('q');
  FakeWebSocket.last.open();
  FakeWebSocket.last.message('half an ans');
  a.c.flush(); // the page is closed here, mid-stream
  const b = setup({ storage: a.storage });
  const msg = b.c.getState().sessions[0].messages.at(-1);
  assert.equal(msg.content, 'half an ans');
  assert.equal(msg.status, 'error');
});

test('unmounting closes the socket and cancels timers', () => {
  const { c, timers } = ready();
  c.sendMessage('q');
  const ws = FakeWebSocket.last;
  ws.open();
  c.stop();
  assert.equal(ws.closeCode, 1000);
  assert.equal(timers.pendingCount, 0);
});

test('storage that refuses writes surfaces a dismissible warning without breaking chat', () => {
  const storage = new MemoryStorage();
  const { c } = setup({ storage });
  c.start();
  FakeWebSocket.last.open();
  storage.failWrites = true;
  FakeWebSocket.last.message('hello');
  FakeWebSocket.last.serverClose(1000);
  c.flush();
  assert.ok(c.getState().storageWarning);
  assert.equal(lastMsg(c).status, 'complete');
  c.dismissStorageWarning();
  assert.equal(c.getState().storageWarning, null);
  c.sendMessage('again'); // saving fails again; the dismissed warning must not nag
  assert.equal(c.getState().storageWarning, null);
});
