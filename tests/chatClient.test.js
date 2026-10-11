import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { FakeWebSocket, createFakeTimers } from './helpers.js';
import { ERROR_CODES, startChatRequest } from '../src/lib/chatClient.js';

beforeEach(() => {
  FakeWebSocket.reset();
  FakeWebSocket.throwOnConstruct = false;
});

function run() {
  const events = [];
  const timers = createFakeTimers();
  const handle = startChatRequest({
    url: 'wss://example.test/chat',
    payload: { chatId: 'c', appId: 'a', systemPrompt: 's', message: 'hi' },
    WebSocketImpl: FakeWebSocket,
    timers,
    connectTimeoutMs: 1000,
    idleTimeoutMs: 2000,
    onOpen: () => events.push(['open']),
    onChunk: (c) => events.push(['chunk', c]),
    onComplete: () => events.push(['complete']),
    onError: (e) => events.push(['error', e.code, e.hasPartial, e.messageSent]),
  });
  return { events, timers, handle, ws: FakeWebSocket.last };
}

test('connects, sends the provider payload once, streams chunks in order, completes on close 1000', () => {
  const { events, ws } = run();
  assert.equal(ws.url, 'wss://example.test/chat');
  ws.open();
  assert.deepEqual(ws.sent, [{ chatId: 'c', appId: 'a', systemPrompt: 's', message: 'hi' }]);
  ws.message('Hel');
  ws.message('lo');
  ws.serverClose(1000);
  assert.deepEqual(events, [['open'], ['chunk', 'Hel'], ['chunk', 'lo'], ['complete']]);
});

test('a socket that errors before opening is a connection failure', () => {
  const { events, ws } = run();
  ws.error();
  ws.serverClose(1006); // the browser also fires close; it must be ignored
  assert.deepEqual(events, [['error', ERROR_CODES.CONNECT_FAILED, false, false]]);
});

test('a socket that never opens times out and is closed', () => {
  const { events, ws, timers } = run();
  timers.advance(999);
  assert.deepEqual(events, []);
  timers.advance(1);
  assert.deepEqual(events, [['error', ERROR_CODES.CONNECT_TIMEOUT, false, false]]);
  assert.equal(ws.closeCode, 1000);
});

test('silence after the request was sent times out; every chunk resets the timer', () => {
  const { events, ws, timers } = run();
  ws.open();
  timers.advance(1500);
  ws.message('a');
  timers.advance(1500);
  assert.equal(events.filter((e) => e[0] === 'error').length, 0);
  timers.advance(500);
  assert.deepEqual(events.at(-1), ['error', ERROR_CODES.IDLE_TIMEOUT, true, true]);
});

test('closing with 1000 and no text is an empty response, not a success', () => {
  const { events, ws } = run();
  ws.open();
  ws.serverClose(1000);
  assert.deepEqual(events.at(-1), ['error', ERROR_CODES.EMPTY, false, true]);
  assert.ok(!events.some((e) => e[0] === 'complete'));
});

test('an abnormal close after partial text reports an interruption with partial=true', () => {
  const { events, ws } = run();
  ws.open();
  ws.message('part');
  ws.serverClose(1006);
  assert.deepEqual(events.at(-1), ['error', ERROR_CODES.INTERRUPTED, true, true]);
  assert.ok(!events.some((e) => e[0] === 'complete'));
});

test('an abnormal close before any text is an interruption with no partial', () => {
  const { events, ws } = run();
  ws.open();
  ws.serverClose(1011);
  assert.deepEqual(events.at(-1), ['error', ERROR_CODES.INTERRUPTED, false, true]);
});

test('non-text frames are rejected as malformed; empty text frames are ignored', () => {
  const a = run();
  a.ws.open();
  a.ws.message('');
  assert.equal(a.events.filter((e) => e[0] === 'chunk').length, 0);
  a.ws.message({ unexpected: true });
  assert.equal(a.events.at(-1)[1], ERROR_CODES.MALFORMED);
});

test('cancel is silent and late events from the cancelled socket are ignored', () => {
  const { events, ws, handle, timers } = run();
  ws.open();
  ws.message('a');
  handle.cancel();
  assert.equal(ws.closeCode, 1000);
  ws.message('late');
  ws.error();
  ws.serverClose(1006);
  timers.advance(60_000);
  assert.deepEqual(events, [['open'], ['chunk', 'a']]);
});

test('only one terminal callback is ever delivered', () => {
  const { events, ws } = run();
  ws.open();
  ws.message('x');
  ws.serverClose(1000);
  ws.serverClose(1006);
  ws.error();
  assert.equal(events.filter((e) => e[0] === 'complete' || e[0] === 'error').length, 1);
});

test('a throwing WebSocket constructor and a throwing send() become errors', () => {
  FakeWebSocket.throwOnConstruct = true;
  const a = run();
  assert.deepEqual(a.events, [['error', ERROR_CODES.CONNECT_FAILED, false, false]]);
  FakeWebSocket.throwOnConstruct = false;

  const events = [];
  startChatRequest({
    url: 'x', payload: {}, WebSocketImpl: class extends FakeWebSocket {
      constructor(u) { super(u); this.throwOnSend = true; }
    },
    timers: createFakeTimers(),
    onError: (e) => events.push(e.code),
  });
  FakeWebSocket.last.open();
  assert.deepEqual(events, [ERROR_CODES.SEND_FAILED]);
});
