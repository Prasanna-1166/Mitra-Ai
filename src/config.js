// Public, browser-side settings. Everything here is visible to users: never put
// secrets in VITE_* variables. Limits, prompts and provider settings live on the
// server (see supabase/functions/_shared/config.js).
const env = import.meta.env ?? {};

const positiveNumber = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const config = {
  // How long to wait for the ticket request / socket to open, and for the next frame.
  connectTimeoutMs: positiveNumber(env.VITE_CONNECT_TIMEOUT_MS, 12000),
  idleTimeoutMs: positiveNumber(env.VITE_IDLE_TIMEOUT_MS, 60000),
  // UX limits; the server enforces its own (MAX_MESSAGE_CHARS, CONTEXT_MAX_MESSAGES).
  maxMessageChars: positiveNumber(env.VITE_MAX_MESSAGE_CHARS, 8000),
  contextMessages: positiveNumber(env.VITE_GUEST_CONTEXT_MESSAGES, 20),
};
