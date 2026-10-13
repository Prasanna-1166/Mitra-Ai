import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { FakeWebSocket, createFakeTimers } from './helpers.js';
import { startRelayRequest } from '../src/lib/relayClient.js';

beforeEach(() => {
  FakeWebSocket.reset();
  FakeWebSocket.throwOnConstruct = false;
});
const tick = () => new Promise((r) => setImmediate(r));
const frame = (ws, f) => ws.message(JSON.stringify(f));

async function run({ getTicket = async () => 'T'.repeat(30), payload = { requestId: 'r1', message: 'hi' } } = {}) {
  const events = [];
  const timers = createFakeTimers();
  const handle = startRelayRequest({
    getTicket, relayUrl: 'wss://x.test/functions/v1/chat-relay', payload, WebSocketImpl: FakeWebSocket, timers,
    connectTimeoutMs: 1000, idleTimeoutMs: 2000,
    onAccepted: (u) => events.push(['accepted', u]),
    onChunk: (c) => events.push(['chunk', c]),
    onComplete: (r) => events.push(['complete', r.usage, r.saved]),
    onError: (e) => events.push(['error', e.code, e.hasPartial, e.messageSent, e.retryable, e.message]),
  });
  await tick();
  return { events, timers, handle, ws: FakeWebSocket.last };
}

test('fetches a ticket, connects with it in the URL, sends the request, streams frames, completes on done', async () => {
  const { events, ws } = await run();
  assert.equal(ws.url, `wss://x.test/functions/v1/chat-relay?ticket=${'T'.repeat(30)}`);
  ws.open();
  assert.deepEqual(ws.sent, [{ type: 'request', requestId: 'r1', message: 'hi' }]);
  frame(ws, { type: 'accepted', usage: { used: 1 } });
  frame(ws, { type: 'chunk', text: 'Hel' });
  frame(ws, { type: 'chunk', text: 'lo' });
  frame(ws, { type: 'done', usage: { used: 1, remaining: 4 } });
  assert.deepEqual(events, [['accepted', { used: 1 }], ['chunk', 'Hel'], ['chunk', 'lo'], ['complete', { used: 1, remaining: 4 }, true]]);
});

test('a socket that merely closes is never reported as success', async () => {
  const { events, ws } = await run();
  ws.open();
  frame(ws, { type: 'chunk', text: 'part' });
  ws.serverClose(1000);
  assert.equal(events.at(-1)[0], 'error');
  assert.deepEqual(events.at(-1).slice(1, 4), ['interrupted', true, true]);
  assert.ok(!events.some((e) => e[0] === 'complete'));
});

test('typed error frames carry quota information and are not retryable when the server says so', async () => {
  const { events, ws } = await run();
  ws.open();
  frame(ws, { type: 'error', code: 'quota_exceeded', message: 'Used up.', usage: { remaining: 0 }, retryable: false });
  assert.deepEqual(events.at(-1), ['error', 'quota_exceeded', false, true, false, 'Used up.']);
});

test('ticket failures surface their code; a failed connection is reported as such', async () => {
  const a = await run({ getTicket: async () => { const e = new Error('x'); e.code = 'invalid_session'; throw e; } });
  assert.deepEqual(a.events.at(-1).slice(0, 4), ['error', 'invalid_session', false, false]);
  const b = await run({ getTicket: async () => { throw new Error('offline'); } });
  assert.equal(b.events.at(-1)[1], 'connect_failed');
  const c = await run();
  c.ws.error();
  assert.deepEqual(c.events.at(-1).slice(0, 4), ['error', 'connect_failed', false, false]);
});

test('timeouts: ticket/connect, and silence after sending (every frame resets the timer)', async () => {
  const a = await run({ getTicket: () => new Promise(() => {}) });
  a.timers.advance(1000);
  assert.equal(a.events.at(-1)[1], 'connect_timeout');

  const b = await run();
  b.ws.open();
  b.timers.advance(1500);
  frame(b.ws, { type: 'accepted' });
  b.timers.advance(1500);
  assert.ok(!b.events.some((e) => e[0] === 'error'));
  b.timers.advance(500);
  assert.equal(b.events.at(-1)[1], 'idle_timeout');
});

test('malformed frames fail the request', async () => {
  for (const bad of ['not json', JSON.stringify({ nope: 1 }), JSON.stringify({ type: 'wat' }), JSON.stringify({ type: 'chunk', text: 5 })]) {
    const { events, ws } = await run();
    ws.open();
    ws.message(bad);
    assert.equal(events.at(-1)[1], 'malformed', bad);
  }
});

test('cancel is silent, tells the relay to stop, and ignores everything afterwards', async () => {
  const { events, ws, handle, timers } = await run();
  ws.open();
  frame(ws, { type: 'chunk', text: 'a' });
  handle.cancel();
  assert.deepEqual(ws.sent.at(-1), { type: 'cancel' });
  assert.equal(ws.closeCode, 1000);
  frame(ws, { type: 'chunk', text: 'late' });
  ws.serverClose(1006);
  timers.advance(60000);
  assert.deepEqual(events, [['chunk', 'a']]);
});

test('cancelling while the ticket is still being fetched never opens a socket', async () => {
  let release;
  const events = [];
  const handle = startRelayRequest({
    getTicket: () => new Promise((r) => { release = r; }), relayUrl: 'wss://x', payload: {}, WebSocketImpl: FakeWebSocket,
    timers: createFakeTimers(), onError: (e) => events.push(e), onComplete: () => events.push('c'),
  });
  await tick(); // the ticket request is now in flight
  handle.cancel();
  release('T'.repeat(30));
  await tick();
  assert.equal(FakeWebSocket.instances.length, 0);
  assert.deepEqual(events, []);
});

test('only one terminal outcome is delivered', async () => {
  const { events, ws } = await run();
  ws.open();
  frame(ws, { type: 'chunk', text: 'x' });
  frame(ws, { type: 'done' });
  frame(ws, { type: 'error', code: 'x' });
  ws.serverClose(1006);
  assert.equal(events.filter((e) => e[0] === 'complete' || e[0] === 'error').length, 1);
});
