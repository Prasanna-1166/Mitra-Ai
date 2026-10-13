// Server-side configuration, read from Edge Function secrets / environment.
// Every number here is an initial product default, not a fixed limit.
const int = (value, fallback, min = 1) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
};

export function readConfig(env = {}) {
  return {
    guestPromptLimit: int(env.GUEST_PROMPT_LIMIT, 5),
    userDailyLimit: int(env.USER_DAILY_LIMIT, 100),
    guestSessionDays: int(env.GUEST_SESSION_DAYS, 30),
    ticketTtlSeconds: int(env.TICKET_TTL_SECONDS, 60),
    maxMessageChars: int(env.MAX_MESSAGE_CHARS, 8000),
    contextMaxChars: int(env.CONTEXT_MAX_CHARS, 12000),
    contextMaxMessages: int(env.CONTEXT_MAX_MESSAGES, 20),
    memoryMaxItems: int(env.MEMORY_MAX_ITEMS, 12),
    memoryMaxChars: int(env.MEMORY_MAX_CHARS, 2000),
    requestsPerMinute: int(env.REQUESTS_PER_MINUTE, 8),
    guestSessionsPerIpPerDay: int(env.GUEST_SESSIONS_PER_IP_PER_DAY, 20),
    upstreamUrl: env.AI_UPSTREAM_WS_URL || 'wss://backend.buildpicoapps.com/api/chatbot/chat',
    upstreamAppId: env.AI_UPSTREAM_APP_ID || 'college-wife',
    upstreamConnectTimeoutMs: int(env.UPSTREAM_CONNECT_TIMEOUT_MS, 10000),
    upstreamIdleTimeoutMs: int(env.UPSTREAM_IDLE_TIMEOUT_MS, 45000),
    totalTimeoutMs: int(env.TOTAL_TIMEOUT_MS, 110000),
    allowedOrigins: (env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    ipHashSalt: env.IP_HASH_SALT || '',
  };
}
