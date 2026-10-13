// One request to the Mitra AI chat relay (see supabase/functions/_shared/protocol.js).
//
//   1. getTicket()            -> short-lived single-use ticket (HTTPS, authenticated)
//   2. WebSocket(relayUrl?ticket=...)
//   3. send { type:'request', ... }   receive accepted / chunk / done / error frames
//
// The request owns its socket and handlers; after it settles (done, error or
// cancel) they are detached, so late events can never reach a newer request.
// Quota, rate-limit and validation failures arrive as typed `error` frames.

export const LOCAL_ERRORS = {
  CONNECT_FAILED: 'connect_failed',
  CONNECT_TIMEOUT: 'connect_timeout',
  IDLE_TIMEOUT: 'idle_timeout',
  INTERRUPTED: 'interrupted',
  MALFORMED: 'malformed',
  SEND_FAILED: 'send_failed',
  SESSION_EXPIRED: 'session_expired',
  NOT_CONFIGURED: 'not_configured',
};

export function describeLocalError(code, hasPartial) {
  switch (code) {
    case LOCAL_ERRORS.CONNECT_FAILED:
      return "Couldn't connect to Mitra AI. Check your internet connection and try again.";
    case LOCAL_ERRORS.CONNECT_TIMEOUT:
      return 'Connecting to Mitra AI took too long.';
    case LOCAL_ERRORS.IDLE_TIMEOUT:
      return hasPartial
        ? 'Mitra AI stopped responding before the answer was finished.'
        : 'Mitra AI did not respond in time.';
    case LOCAL_ERRORS.INTERRUPTED:
      return hasPartial
        ? 'The connection was lost before the answer was finished.'
        : 'The connection was lost before an answer arrived.';
    case LOCAL_ERRORS.MALFORMED:
      return 'Mitra AI sent a response in an unexpected format.';
    case LOCAL_ERRORS.SEND_FAILED:
      return "Your message couldn't be sent.";
    case LOCAL_ERRORS.SESSION_EXPIRED:
      return 'Your session has expired. Please sign in again.';
    case LOCAL_ERRORS.NOT_CONFIGURED:
      return 'The Mitra AI backend is not configured for this deployment.';
    default:
      return 'Something went wrong while contacting Mitra AI.';
  }
}

const defaultTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
};

export function startRelayRequest({
  getTicket,
  relayUrl,
  payload,
  WebSocketImpl,
  connectTimeoutMs = 10000,
  idleTimeoutMs = 45000,
  timers = defaultTimers,
  onAccepted,
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
    timer = timers.setTimeout(() => fail({ code }), ms);
  };
  const teardown = (notifyServer) => {
    clearTimer();
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    try {
      if (notifyServer && ws.readyState === 1) ws.send(JSON.stringify({ type: 'cancel' }));
      if (ws.readyState === 0 || ws.readyState === 1) ws.close(1000);
    } catch {
      /* already closing */
    }
  };
  function fail({ code, message, usage, retryable, hasPartial }) {
    if (settled) return;
    settled = true;
    teardown(false);
    const partial = hasPartial ?? received > 0;
    onError?.({
      code,
      message: message || describeLocalError(code, partial),
      usage,
      retryable: retryable ?? true,
      hasPartial: partial,
      messageSent: sent,
    });
  }

  arm(connectTimeoutMs, LOCAL_ERRORS.CONNECT_TIMEOUT);

  Promise.resolve()
    .then(() => getTicket())
    .then((ticket) => {
      if (settled) return;
      try {
        ws = new SocketCtor(`${relayUrl}${relayUrl.includes('?') ? '&' : '?'}ticket=${encodeURIComponent(ticket)}`);
      } catch {
        fail({ code: LOCAL_ERRORS.CONNECT_FAILED });
        return;
      }
      ws.onopen = () => {
        if (settled) return;
        opened = true;
        try {
          ws.send(JSON.stringify({ type: 'request', ...payload }));
          sent = true;
        } catch {
          fail({ code: LOCAL_ERRORS.SEND_FAILED });
          return;
        }
        arm(idleTimeoutMs, LOCAL_ERRORS.IDLE_TIMEOUT);
      };
      ws.onmessage = (event) => {
        if (settled) return;
        let frame = null;
        try {
          frame = typeof event.data === 'string' ? JSON.parse(event.data) : null;
        } catch {
          frame = null;
        }
        if (!frame || typeof frame.type !== 'string') {
          fail({ code: LOCAL_ERRORS.MALFORMED });
          return;
        }
        arm(idleTimeoutMs, LOCAL_ERRORS.IDLE_TIMEOUT);
        if (frame.type === 'accepted') {
          onAccepted?.(frame.usage);
        } else if (frame.type === 'chunk') {
          if (typeof frame.text !== 'string') {
            fail({ code: LOCAL_ERRORS.MALFORMED });
          } else if (frame.text) {
            received += frame.text.length;
            onChunk?.(frame.text);
          }
        } else if (frame.type === 'done') {
          // Success is only ever signalled by the relay's explicit `done` frame,
          // never by the socket closing.
          settled = true;
          teardown(false);
          onComplete?.({ usage: frame.usage, saved: frame.saved !== false });
        } else if (frame.type === 'error') {
          fail({
            code: typeof frame.code === 'string' ? frame.code : 'internal',
            message: typeof frame.message === 'string' ? frame.message : undefined,
            usage: frame.usage,
            retryable: frame.retryable !== false,
            hasPartial: frame.hasPartial === true || received > 0,
          });
        } else {
          fail({ code: LOCAL_ERRORS.MALFORMED });
        }
      };
      ws.onerror = () => fail({ code: opened ? LOCAL_ERRORS.INTERRUPTED : LOCAL_ERRORS.CONNECT_FAILED });
      ws.onclose = () => fail({ code: opened ? LOCAL_ERRORS.INTERRUPTED : LOCAL_ERRORS.CONNECT_FAILED });
    })
    .catch((err) => {
      // Ticket request failed (network, expired session, rate limit, no backend).
      fail({
        code: err?.code && typeof err.code === 'string' ? err.code : LOCAL_ERRORS.CONNECT_FAILED,
        message: err?.userMessage,
        usage: err?.usage,
        retryable: err?.code !== 'invalid_session',
      });
    });

  return {
    // Silent: no callbacks fire after cancel(). The relay is told to stop.
    cancel() {
      if (settled) return;
      settled = true;
      teardown(true);
    },
  };
}
