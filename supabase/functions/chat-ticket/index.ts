// POST /functions/v1/chat-ticket
//   { purpose: 'status' | 'ticket' }
// Identifies the caller (signed-in user via Authorization: Bearer <JWT>, otherwise
// an anonymous guest session via x-guest-token), reports the remaining
// allowance, and for purpose 'ticket' issues a short-lived single-use ticket for
// the chat-relay WebSocket (browsers cannot send headers on a WebSocket).
// deno-lint-ignore-file no-explicit-any
import { readConfig } from '../_shared/config.js';
import { isOriginAllowed } from '../_shared/origin.js';
import { adminClient, bearerToken, corsHeaders, json, randomToken, sha256 } from '../_shared/edge.ts';
import { createRepo } from '../_shared/db.ts';

Deno.serve(async (req: Request) => {
  const cfg = readConfig(Deno.env.toObject());
  const cors = corsHeaders(req, cfg.allowedOrigins);
  if (!isOriginAllowed(req.headers.get('origin'), cfg.allowedOrigins)) return json({ code: 'origin_not_allowed' }, 403, cors);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json({ code: 'method_not_allowed' }, 405, cors);

  try {
    const body = await req.json().catch(() => ({}));
    const purpose = body?.purpose === 'status' ? 'status' : 'ticket';
    const admin = adminClient();
    const repo = createRepo(admin);

    let userId: string | null = null;
    let guestSessionId: string | null = null;
    let newGuestToken: string | undefined;

    const jwt = bearerToken(req);
    if (jwt !== null) {
      // A token was sent, so it must be a valid user session (expired -> 401, the client refreshes).
      const { data, error } = await admin.auth.getUser(jwt);
      if (error || !data?.user) return json({ code: 'invalid_session' }, 401, cors);
      userId = data.user.id;
    } else {
      const presented = req.headers.get('x-guest-token') ?? '';
      let session: any = null;
      if (/^[A-Za-z0-9_-]{20,100}$/.test(presented)) {
        const { data } = await admin.from('guest_sessions').select('id')
          .eq('token_hash', await sha256(presented)).gt('expires_at', new Date().toISOString()).maybeSingle();
        session = data;
      }
      if (!session) {
        // Throttle creation per (salted, daily-rotating) IP hash. The IP itself is never stored.
        const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown';
        const day = new Date().toISOString().slice(0, 10);
        const allowed = await repo.rateLimit(
          `guest-create:${await sha256(`${cfg.ipHashSalt}|${day}|${ip}`)}`, 86400, cfg.guestSessionsPerIpPerDay);
        if (!allowed) return json({ code: 'rate_limited' }, 429, cors);
        newGuestToken = randomToken(32);
        const expires = new Date(Date.now() + cfg.guestSessionDays * 86400_000).toISOString();
        const { data, error } = await admin.from('guest_sessions')
          .insert({ token_hash: await sha256(newGuestToken), expires_at: expires }).select('id').single();
        if (error) throw error;
        session = data;
      }
      guestSessionId = session.id;
    }

    const limit = userId ? cfg.userDailyLimit : cfg.guestPromptLimit;
    const usage = await repo.getUsage({ userId, guestSessionId, limit });
    const result: Record<string, unknown> = {
      kind: userId ? 'user' : 'guest',
      usage,
      limits: { guest: cfg.guestPromptLimit, user: cfg.userDailyLimit }, // so the UI never hard-codes them
    };
    if (newGuestToken) result.guestToken = newGuestToken;

    if (purpose === 'ticket') {
      const ticket = randomToken(24);
      const { error } = await admin.from('chat_tickets').insert({
        token_hash: await sha256(ticket),
        user_id: userId,
        guest_session_id: guestSessionId,
        expires_at: new Date(Date.now() + cfg.ticketTtlSeconds * 1000).toISOString(),
      });
      if (error) throw error;
      result.ticket = ticket;
    }
    if (Math.random() < 0.02) admin.rpc('purge_expired').then(() => {}, () => {});
    return json(result, 200, cors);
  } catch (err) {
    console.error('chat-ticket failed:', (err as Error)?.message); // no tokens or payloads
    return json({ code: 'internal' }, 500, cors);
  }
});
