// One streaming request over the provider's WebSocket.
//
// Provider protocol (taken from the existing integration, unchanged):
//   client -> server : one JSON message { chatId, appId, systemPrompt, message }
//   server -> client : plain-text chunks, one per WebSocket message
//   server closes with code 1000 when the answer is complete
//
// Every request owns its socket and its handlers. After the request settles
// (complete, error or cancel) its handlers are detached, so events from an
// old socket can never reach a newer request.

export const ERROR_CODES = {
  CONNECT_FAILED: 'connect_failed',
  CONNECT_TIMEOUT: 'connect_timeout',
  IDLE_TIMEOUT: 'idle_timeout',
  INTERRUPTED: 'interrupted',
  EMPTY: 'empty',
  MALFORMED: 'malformed',
  SEND_FAILED: 'send_failed',
};

export function describeError(code, hasPartial) {
  switch (code) {
    case ERROR_CODES.CONNECT_FAILED:
      return "Couldn't connect to the AI service. Check your internet connection and try again.";
    case ERROR_CODES.CONNECT_TIMEOUT:
      return 'Connecting to the AI service took too long.';
    case ERROR_CODES.IDLE_TIMEOUT:
      return hasPartial
        ? 'The AI service stopped responding before the answer was finished.'
        : 'The AI service did not respond in time.';
    case ERROR_CODES.INTERRUPTED:
      return hasPartial
        ? 'The connection was lost before the answer was finished.'
        : 'The connection was lost before an answer arrived.';
    case ERROR_CODES.EMPTY:
      return 'The AI service finished without sending an answer.';
    case ERROR_CODES.MALFORMED:
      return 'The AI service sent a response in an unexpected format.';
    case ERROR_CODES.SEND_FAILED:
      return "Your message couldn't be sent to the AI service.";
    default:
      return 'Something went wrong while contacting the AI service.';
  }
}

const defaultTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
};

export function startChatRequest({
  url,
  payload,
  WebSocketImpl,
  connectTimeoutMs = 10000,
  idleTimeoutMs = 45000,
  timers = defaultTimers,
  onOpen,
  onChunk,
  onComplete,
  onError,
}) {
  const SocketCtor = WebSocketImpl ?? globalThis.WebSocket;
  let ws = null;
  let settled = false;
  let opened = false;
  let sent = false;
  let received = 0;
  let timer = null;

  const clearTimer = () => {
    if (timer !== null) {
      timers.clearTimeout(timer);
      timer = null;
    }
  };
  const arm = (ms, code) => {
    clearTimer();
    timer = timers.setTimeout(() => fail(code), ms);
  };
  const teardown = () => {
    clearTimer();
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    try {
      // 0 = CONNECTING, 1 = OPEN
      if (ws.readyState === 0 || ws.readyState === 1) ws.close(1000);
    } catch {
      /* already closing */
    }
  };
  function fail(code) {
    if (settled) return;
    settled = true;
    teardown();
    const hasPartial = received > 0;
    onError?.({ code, message: describeError(code, hasPartial), hasPartial, messageSent: sent });
  }
  function complete() {
    if (settled) return;
    settled = true;
    teardown();
    onComplete?.();
  }

  try {
    ws = new SocketCtor(url);
  } catch {
    ws = null;
    fail(ERROR_CODES.CONNECT_FAILED);
    return { cancel() {} };
  }

  arm(connectTimeoutMs, ERROR_CODES.CONNECT_TIMEOUT);

  ws.onopen = () => {
    if (settled) return;
    opened = true;
    try {
      ws.send(JSON.stringify(payload));
      sent = true;
    } catch {
      fail(ERROR_CODES.SEND_FAILED);
      return;
    }
    arm(idleTimeoutMs, ERROR_CODES.IDLE_TIMEOUT);
    onOpen?.();
  };

  ws.onmessage = (event) => {
    if (settled) return;
    const data = event?.data;
    if (typeof data !== 'string') {
      fail(ERROR_CODES.MALFORMED);
      return;
    }
    arm(idleTimeoutMs, ERROR_CODES.IDLE_TIMEOUT);
    if (data === '') return;
    received += data.length;
    onChunk?.(data);
  };

  ws.onerror = () => {
    if (settled) return;
    fail(opened ? ERROR_CODES.INTERRUPTED : ERROR_CODES.CONNECT_FAILED);
  };

  ws.onclose = (event) => {
    if (settled) return;
    if (event?.code === 1000) {
      if (received > 0) complete();
      else fail(ERROR_CODES.EMPTY);
    } else {
      fail(opened ? ERROR_CODES.INTERRUPTED : ERROR_CODES.CONNECT_FAILED);
    }
  };

  return {
    // Silent: no callbacks fire after cancel(); the caller records the outcome.
    cancel() {
      if (settled) return;
      settled = true;
      teardown();
    },
  };
}
