import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { FakeWebSocket, createFakeTimers } from './helpers.js';
import { FakeClientSocket, FakeRepo } from './fakeRepo.js';
import { handleRelayConnection } from '../supabase/functions/_shared/relay-core.js';
import { readConfig } from '../supabase/functions/_shared/config.js';

const cfg = readConfig({});
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CONV = U(900);
const baseReq = (n, extra = {}) => ({
  type: 'request', requestId: U(n), userMessageId: U(n + 100), assistantMessageId: U(n + 200),
  message: 'How do I center a div?', ...extra,
});

beforeEach(() => {
  FakeWebSocket.reset();
  FakeWebSocket.throwOnConstruct = false;
});

function connect({ subject = { guestSessionId: 'g1' }, repo = new FakeRepo(), config = cfg } = {}) {
  const socket = new FakeClientSocket();
  const timers = createFakeTimers();
  handleRelayConnection({ socket, subject, cfg: config, repo, UpstreamWebSocket: FakeWebSocket, timers });
  return { socket, repo, timers };
}
const tick = () => new Promise((r) => setImmediate(r));
async function settle() {
  for (let i = 0; i < 6; i += 1) await tick();
}
const upstream = () => FakeWebSocket.last;

test('guest: validated request streams chunks in order and reports usage', async () => {
  const { socket } = connect();
  socket.receive(baseReq(1, { depth: 'detailed', history: [{ role: 'user', content: 'Earlier question' }, { role: 'assistant', content: 'Earlier answer' }] }));
  await settle();
  assert.deepEqual(socket.sent[0], { type: 'accepted', usage: { used: 1, limit: 5, remaining: 4, resetsAt: null } });
  const up = upstream();
  assert.equal(up.url, cfg.upstreamUrl);
  up.open();
  assert.deepEqual(Object.keys(up.sent[0]).sort(), ['appId', 'chatId', 'message', 'systemPrompt']);
  assert.equal(up.sent[0].appId, 'college-wife');
  assert.equal(up.sent[0].chatId, U(1), 'a fresh chatId per request: no reliance on provider-side state');
  assert.match(up.sent[0].systemPrompt, /Response style: detailed/);
  assert.match(up.sent[0].message, /Earlier question/);
  assert.match(up.sent[0].message, /How do I center a div\?$/);
  up.message('Use ');
  up.message('flexbox.');
  up.serverClose(1000);
  await settle();
  assert.deepEqual(socket.sent.filter((f) => f.type === 'chunk').map((f) => f.text), ['Use ', 'flexbox.']);
  assert.equal(socket.sent.at(-1).type, 'done');
  assert.equal(socket.sent.at(-1).usage.used, 1);
  assert.equal(socket.closed, 1000);
});

test('guest: the sixth question is rejected and the provider is never contacted', async () => {
  const repo = new FakeRepo();
  for (let i = 1; i <= 5; i += 1) {
    const { socket } = connect({ repo });
    socket.receive(baseReq(i));
    await settle();
    upstream().open(); upstream().message('ok'); upstream().serverClose(1000);
    await settle();
    assert.equal(socket.sent.at(-1).type, 'done', `question ${i}`);
  }
  const count = FakeWebSocket.instances.length;
  const { socket } = connect({ repo });
  socket.receive(baseReq(6));
  await settle();
  assert.equal(socket.sent[0].type, 'error');
  assert.equal(socket.sent[0].code, 'quota_exceeded');
  assert.equal(socket.sent[0].usage.remaining, 0);
  assert.equal(socket.sent[0].retryable, false);
  assert.equal(FakeWebSocket.instances.length, count);
});

test('concurrent requests cannot overspend the allowance', async () => {
  const repo = new FakeRepo();
  const cfg1 = { ...cfg, guestPromptLimit: 1 };
  const a = connect({ repo, config: cfg1 });
  const b = connect({ repo, config: cfg1 });
  a.socket.receive(baseReq(1));
  b.socket.receive(baseReq(2));
  await settle();
  const codes = [a.socket, b.socket].map((s) => s.sent[0].type === 'accepted' ? 'ok' : s.sent[0].code).sort();
  assert.deepEqual(codes, ['ok', 'quota_exceeded']);
  assert.equal(FakeWebSocket.instances.length, 1);
});

test('signed-in: context and memory come from the database, never from the client', async () => {
  const repo = new FakeRepo({
    conversations: { u1: new Set([CONV]) },
    history: { [CONV]: [
      { role: 'user', content: 'What is Vite?' },
      { role: 'assistant', content: 'A build tool.', status: 'complete' },
      { role: 'assistant', content: 'PARTIAL TEXT', status: 'error' },
    ] },
    prefs: { u1: { depth: 'concise', memories: [
      { content: 'I prefer TypeScript for all examples', category: 'preference', enabled: true },
      { content: 'Working on a Vite app called Orbit', category: 'project', enabled: true },
      { content: 'Disabled memory about cooking', category: 'preference', enabled: false },
      { content: 'Unrelated fact about gardening roses', category: 'fact', enabled: true },
    ] } },
  });
  const { socket } = connect({ subject: { userId: 'u1' }, repo });
  socket.receive(baseReq(1, { conversationId: CONV, message: 'How do I configure Vite proxy?', depth: 'detailed', history: [{ role: 'user', content: 'FORGED CONTEXT' }] }));
  await settle();
  upstream().open();
  const sent = upstream().sent[0];
  assert.match(sent.systemPrompt, /Response style: concise/, 'depth comes from saved settings');
  assert.match(sent.systemPrompt, /I prefer TypeScript/);
  assert.match(sent.systemPrompt, /Orbit/);
  assert.doesNotMatch(sent.systemPrompt, /cooking|gardening/);
  assert.match(sent.systemPrompt, /<user_memory>[^]*<\/user_memory>/);
  assert.match(sent.systemPrompt, /DATA/);
  assert.match(sent.message, /What is Vite\?/);
  assert.doesNotMatch(sent.message, /FORGED|PARTIAL TEXT/);
  assert.equal(repo.messages[0].role, 'user', 'user message saved before the provider is contacted');
  assert.equal(repo.messages[0].messageId, U(101));
  upstream().message('Use server.proxy.');
  upstream().serverClose(1000);
  await settle();
  const saved = repo.messages.at(-1);
  assert.deepEqual([saved.role, saved.status, saved.content, saved.messageId], ['assistant', 'complete', 'Use server.proxy.', U(201)]);
  assert.equal(socket.sent.at(-1).usage.limit, 100);
  assert.equal(socket.sent.at(-1).usage.resetsAt, '2026-10-12T00:00:00.000Z');
});

test('signed-in: a conversation the user does not own is rejected before any accounting or upstream call', async () => {
  const repo = new FakeRepo({ conversations: { u1: new Set([CONV]), u2: new Set() } });
  const { socket } = connect({ subject: { userId: 'u2' }, repo });
  socket.receive(baseReq(1, { conversationId: CONV }));
  await settle();
  assert.equal(socket.sent[0].code, 'conversation_not_found');
  assert.equal(repo.usage.size, 0);
  assert.equal(repo.messages.length, 0);
  assert.equal(FakeWebSocket.instances.length, 0);
});

test('failure before any text releases the prompt and records an error message', async () => {
  const repo = new FakeRepo({ conversations: { u1: new Set([CONV]) } });
  const { socket } = connect({ subject: { userId: 'u1' }, repo });
  socket.receive(baseReq(1, { conversationId: CONV }));
  await settle();
  upstream().open();
  upstream().serverClose(1011);
  await settle();
  assert.deepEqual(repo.calls.at(-1), ['finalize', U(1), 'failed']);
  assert.equal(socket.sent.at(-1).usage.used, 0, 'allowance not consumed');
  assert.equal(socket.sent.at(-1).code, 'upstream_failed');
  assert.equal(socket.sent.at(-1).hasPartial, false);
  assert.equal(repo.messages.at(-1).status, 'error');
});

test('failure after partial text keeps the text, charges the prompt and flags it as partial', async () => {
  const repo = new FakeRepo({ conversations: { u1: new Set([CONV]) } });
  const { socket } = connect({ subject: { userId: 'u1' }, repo });
  socket.receive(baseReq(1, { conversationId: CONV }));
  await settle();
  upstream().open();
  upstream().message('Half an ans');
  upstream().serverClose(1006);
  await settle();
  assert.deepEqual(repo.calls.at(-1), ['finalize', U(1), 'partial']);
  assert.equal(socket.sent.at(-1).hasPartial, true);
  assert.equal(socket.sent.at(-1).usage.used, 1);
  assert.deepEqual([repo.messages.at(-1).status, repo.messages.at(-1).content], ['error', 'Half an ans']);
});

test('a 1000 close without text is an empty response (released), never a success', async () => {
  const { socket, repo } = connect();
  socket.receive(baseReq(1));
  await settle();
  upstream().open();
  upstream().serverClose(1000);
  await settle();
  assert.equal(socket.sent.at(-1).code, 'upstream_empty');
  assert.deepEqual(repo.calls.at(-1), ['finalize', U(1), 'failed']);
});

test('provider timeouts: connect timeout releases, idle timeout after text charges', async () => {
  const a = connect();
  a.socket.receive(baseReq(1));
  await settle();
  a.timers.advance(cfg.upstreamConnectTimeoutMs);
  await settle();
  assert.equal(a.socket.sent.at(-1).code, 'upstream_timeout');
  assert.deepEqual(a.repo.calls.at(-1), ['finalize', U(1), 'failed']);
  assert.equal(upstream().closeCode, 1000, 'the upstream socket is closed');

  const b = connect();
  b.socket.receive(baseReq(2));
  await settle();
  upstream().open();
  upstream().message('x');
  b.timers.advance(cfg.upstreamIdleTimeoutMs);
  await settle();
  assert.deepEqual(b.repo.calls.at(-1), ['finalize', U(2), 'partial']);
  assert.equal(b.socket.sent.at(-1).hasPartial, true);
});

test('client cancel mid-stream closes the provider socket, keeps partial text and stops sending', async () => {
  const repo = new FakeRepo({ conversations: { u1: new Set([CONV]) } });
  const { socket } = connect({ subject: { userId: 'u1' }, repo });
  socket.receive(baseReq(1, { conversationId: CONV }));
  await settle();
  const up = upstream();
  up.open();
  up.message('part');
  socket.receive({ type: 'cancel' });
  await settle();
  assert.equal(up.closeCode, 1000);
  assert.deepEqual(repo.calls.at(-1), ['finalize', U(1), 'partial']);
  assert.deepEqual([repo.messages.at(-1).status, repo.messages.at(-1).content], ['stopped', 'part']);
  const framesBefore = socket.sent.length;
  up.message('late'); // handlers detached
  up.serverClose(1000);
  await settle();
  assert.equal(socket.sent.length, framesBefore);
  assert.equal(repo.calls.filter((c) => c[0] === 'finalize').length, 1);
});

test('cancel before any text, and the browser vanishing, both release the prompt', async () => {
  const a = connect();
  a.socket.receive(baseReq(1));
  await settle();
  upstream().open();
  a.socket.receive({ type: 'cancel' });
  await settle();
  assert.deepEqual(a.repo.calls.at(-1), ['finalize', U(1), 'cancelled']);

  const b = connect();
  b.socket.receive(baseReq(2));
  await settle();
  upstream().open();
  b.socket.drop();
  await settle();
  assert.deepEqual(b.repo.calls.at(-1), ['finalize', U(2), 'cancelled']);
  assert.equal(upstream().closeCode, 1000);
});

test('rate limiting rejects before accounting', async () => {
  const repo = new FakeRepo();
  repo.rateAllowed = false;
  const { socket } = connect({ repo });
  socket.receive(baseReq(1));
  await settle();
  assert.equal(socket.sent[0].code, 'rate_limited');
  assert.equal(repo.usage.size, 0);
  assert.deepEqual(repo.rateCalls[0], ['guest:g1', 60, 8]);
});

test('invalid payloads are rejected; only one request per connection', async () => {
  for (const bad of [
    { type: 'request' }, 'not json', { ...baseReq(1), message: '   ' },
    { ...baseReq(1), message: 'x'.repeat(cfg.maxMessageChars + 1) }, { ...baseReq(1), requestId: 'nope' },
    { ...baseReq(1), history: 'x' }, { ...baseReq(1), history: [{ role: 'system', content: 'x' }] },
  ]) {
    const { socket, repo } = connect();
    socket.receive(bad);
    await settle();
    assert.equal(socket.sent[0].code, 'invalid_request', JSON.stringify(bad).slice(0, 60));
    assert.equal(repo.usage.size, 0);
  }
  const { socket } = connect();
  socket.receive(baseReq(1));
  await settle();
  socket.receive(baseReq(2));
  await settle();
  assert.equal(socket.sent.filter((f) => f.code === 'invalid_request').length, 1);
  assert.equal(FakeWebSocket.instances.length, 1);
});

test('signed-in requests need a conversation id; a reused request id is a duplicate', async () => {
  const repo = new FakeRepo({ conversations: { u1: new Set([CONV]) } });
  const a = connect({ subject: { userId: 'u1' }, repo });
  a.socket.receive(baseReq(1));
  await settle();
  assert.equal(a.socket.sent[0].code, 'invalid_request');

  const b = connect({ subject: { userId: 'u1' }, repo });
  b.socket.receive(baseReq(2, { conversationId: CONV }));
  await settle();
  upstream().open(); upstream().message('x'); upstream().serverClose(1000);
  await settle();
  const c = connect({ subject: { userId: 'u1' }, repo });
  c.socket.receive(baseReq(2, { conversationId: CONV }));
  await settle();
  assert.equal(c.socket.sent[0].code, 'duplicate_request');
});

test('a database failure becomes an internal error and never reaches the provider', async () => {
  const repo = new FakeRepo();
  repo.failOn = 'reserve';
  const { socket } = connect({ repo });
  socket.receive(baseReq(1));
  await settle();
  assert.equal(socket.sent[0].code, 'internal');
  assert.equal(FakeWebSocket.instances.length, 0);
});

test('failure to save the assistant message is reported but the answer still completes', async () => {
  const repo = new FakeRepo({ conversations: { u1: new Set([CONV]) } });
  repo.failOn = 'saveAssistant';
  const { socket } = connect({ subject: { userId: 'u1' }, repo });
  socket.receive(baseReq(1, { conversationId: CONV }));
  await settle();
  upstream().open(); upstream().message('ok'); upstream().serverClose(1000);
  await settle();
  assert.equal(socket.sent.at(-1).type, 'done');
  assert.equal(socket.sent.at(-1).saved, false);
});

test('a provider that cannot be constructed fails cleanly', async () => {
  FakeWebSocket.throwOnConstruct = true;
  const { socket, repo } = connect();
  socket.receive(baseReq(1));
  await settle();
  assert.equal(socket.sent.at(-1).code, 'upstream_failed');
  assert.deepEqual(repo.calls.at(-1), ['finalize', U(1), 'failed']);
});
