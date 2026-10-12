// POST /functions/v1/delete-account   { confirm: 'DELETE' }   Authorization: Bearer <user JWT>
// Deletes the Supabase Auth user. Foreign keys with ON DELETE CASCADE then remove
// the account's conversations, messages, memories, settings, tickets and usage records.
import { adminClient, bearerToken, corsHeaders, json } from '../_shared/edge.ts';
import { readConfig } from '../_shared/config.js';

Deno.serve(async (req: Request) => {
  const cfg = readConfig(Deno.env.toObject());
  const cors = corsHeaders(req, cfg.allowedOrigins);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json({ code: 'method_not_allowed' }, 405, cors);

  try {
    const jwt = bearerToken(req);
    if (!jwt) return json({ code: 'unauthorized' }, 401, cors);
    const body = await req.json().catch(() => ({}));
    if (body?.confirm !== 'DELETE') return json({ code: 'confirmation_required' }, 400, cors);

    const admin = adminClient();
    const { data, error } = await admin.auth.getUser(jwt);
    if (error || !data?.user) return json({ code: 'invalid_session' }, 401, cors);

    const { error: deleteError } = await admin.auth.admin.deleteUser(data.user.id);
    if (deleteError) throw deleteError;
    return json({ ok: true }, 200, cors);
  } catch (err) {
    console.error('delete-account failed:', (err as Error)?.message);
    return json({ code: 'internal' }, 500, cors);
  }
});
