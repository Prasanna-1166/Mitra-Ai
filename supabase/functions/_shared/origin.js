// Server-side Origin validation. CORS headers alone only instruct browsers; this
// makes the functions themselves refuse requests from other web origins.
//
// allowed: configured list (ALLOWED_ORIGINS). Empty list = no restriction (local
// development only; the README requires setting it in production).
// requireOrigin: browsers always send Origin on WebSocket upgrades and cross-origin
// fetches, so the relay demands it whenever a list is configured.
export function matchesOrigin(origin, pattern) {
  if (pattern === origin) return true;
  if (typeof pattern === 'string' && pattern.includes('*')) {
    const escaped = pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[a-zA-Z0-9_.:-]+');
    return new RegExp(`^${escaped}$`).test(origin);
  }
  return false;
}

export function isOriginAllowed(origin, allowed, { requireOrigin = false } = {}) {
  if (!Array.isArray(allowed) || allowed.length === 0) return true;
  if (!origin) return !requireOrigin;
  return allowed.some((pattern) => matchesOrigin(origin, pattern));
}
