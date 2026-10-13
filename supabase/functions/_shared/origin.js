// Server-side Origin validation. CORS headers alone only instruct browsers; this
// makes the functions themselves refuse requests from other web origins.
//
// allowed: configured list (ALLOWED_ORIGINS). Empty list = no restriction (local
// development only; the README requires setting it in production).
// requireOrigin: browsers always send Origin on WebSocket upgrades and cross-origin
// fetches, so the relay demands it whenever a list is configured.
export function isOriginAllowed(origin, allowed, { requireOrigin = false } = {}) {
  if (!Array.isArray(allowed) || allowed.length === 0) return true;
  if (!origin) return !requireOrigin;
  return allowed.includes(origin);
}
