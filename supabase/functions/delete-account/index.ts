// POST /functions/v1/delete-account   { confirm: 'DELETE' }   Authorization: Bearer <user JWT>
// Deletes the Supabase Auth user. Foreign keys with ON DELETE CASCADE then remove
// the account's conversations, messages, memories, settings, tickets and usage records.
import { adminClient, bearerToken, corsHeaders, json } from '../_shared/edge.ts';
import { readConfig } from '../_shared/config.js';

// deno-lint-ignore-file no-explicit-any
declare const Deno: any;

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

    // Clean up avatar storage objects if any exist for this account
    try {
      const { data: files } = await admin.storage.from('avatars').list(data.user.id);
      if (files && files.length > 0) {
        const paths = files.map((f: { name: string }) => `${data.user.id}/${f.name}`);
        await admin.storage.from('avatars').remove(paths);
      }
    } catch (storageErr) {
      console.warn('delete-account storage cleanup note:', (storageErr as Error)?.message);
    }

    const { error: deleteError } = await admin.auth.admin.deleteUser(data.user.id);
    if (deleteError) throw deleteError;
    return json({ ok: true }, 200, cors);
  } catch (err) {
    console.error('delete-account failed:', (err as Error)?.message);
    return json({ code: 'internal' }, 500, cors);
  }
});
