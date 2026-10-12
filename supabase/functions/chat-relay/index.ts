// WebSocket relay between the browser and the AI provider.
//   wss://<project>.supabase.co/functions/v1/chat-relay?ticket=<single-use ticket>
// The ticket (from chat-ticket) is consumed atomically before the upgrade.
// All policy (limits, context, memory, persistence) lives in _shared/relay-core.js.
// deno-lint-ignore-file no-explicit-any
import { readConfig } from '../_shared/config.js';
import { handleRelayConnection } from '../_shared/relay-core.js';
import { adminClient, sha256 } from '../_shared/edge.ts';
import { createRepo } from '../_shared/db.ts';

declare const Deno: any;

Deno.serve(async (req: Request) => {
  if ((req.headers.get('upgrade') ?? '').toLowerCase() !== 'websocket') {
    return new Response('Expected a WebSocket connection', { status: 426 });
  }
  const cfg = readConfig(Deno.env.toObject());

  // Cross-site WebSocket hijacking guard (the ticket is also single-use and short-lived).
  const origin = req.headers.get('origin') ?? '';
  if (cfg.allowedOrigins.length > 0 && !cfg.allowedOrigins.includes(origin)) {
    return new Response('Origin not allowed', { status: 403 });
  }

  const ticket = new URL(req.url).searchParams.get('ticket') ?? '';
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(ticket)) return new Response('Invalid ticket', { status: 401 });

  let subject: { userId?: string; guestSessionId?: string };
  try {
    const admin = adminClient();
    const now = new Date().toISOString();
    // One statement: only an unused, unexpired ticket matches, and it is marked used.
    const { data, error } = await admin.from('chat_tickets')
      .update({ used_at: now }).eq('token_hash', await sha256(ticket))
      .is('used_at', null).gt('expires_at', now)
      .select('user_id, guest_session_id').maybeSingle();
    if (error || !data) return new Response('Invalid or expired ticket', { status: 401 });
    if (data.guest_session_id) {
      const { data: session } = await admin.from('guest_sessions').select('id')
        .eq('id', data.guest_session_id).gt('expires_at', now).maybeSingle();
      if (!session) return new Response('Guest session expired', { status: 401 });
      subject = { guestSessionId: data.guest_session_id };
    } else {
      subject = { userId: data.user_id };
    }

    const { socket, response } = Deno.upgradeWebSocket(req);
    handleRelayConnection({
      socket,
      subject,
      cfg,
      repo: createRepo(admin),
      UpstreamWebSocket: WebSocket,
      // Log event names and error messages only, never prompts, answers or tokens.
      log: (event?: string, detail?: string) => console.error(`chat-relay ${event ?? ''}${detail ? `: ${detail}` : ''}`),
    });
    return response;
  } catch (err) {
    console.error('chat-relay setup failed:', (err as Error)?.message);
    return new Response('Server error', { status: 500 });
  }
});
