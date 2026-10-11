// Deployment settings. Everything here is PUBLIC: Vite inlines VITE_* variables
// into the browser bundle, so never put secrets or private keys in them.
const env = import.meta.env ?? {};

const positiveNumber = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const config = {
  // Existing provider endpoint and application identifier (defaults preserved).
  wsUrl: env.VITE_AI_WS_URL || 'wss://backend.buildpicoapps.com/api/chatbot/chat',
  appId: env.VITE_AI_APP_ID || 'college-wife',
  systemPrompt:
    env.VITE_AI_SYSTEM_PROMPT ||
    'You are Mitra AI, a friendly, intelligent, and helpful AI assistant designed to race through problems and find solutions fast.',
  welcomePrompt: 'A welcoming introduction from Mitra AI',
  // Give up if the socket has not opened within this time.
  connectTimeoutMs: positiveNumber(env.VITE_AI_CONNECT_TIMEOUT_MS, 10000),
  // Give up if the provider is silent for this long after the request is sent
  // (reset on every received chunk).
  idleTimeoutMs: positiveNumber(env.VITE_AI_IDLE_TIMEOUT_MS, 45000),
};
