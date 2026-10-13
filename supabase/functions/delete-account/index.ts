// POST /functions/v1/delete-account   { confirm: 'DELETE' }   Authorization: Bearer <user JWT>
// Deletes the CALLING user (identified only by the verified JWT): avatar objects first,
// then the Auth user; ON DELETE CASCADE removes the rest. See _shared/account.js.
// deno-lint-ignore-file no-explicit-any
import { readConfig } from '../_shared/config.js';
import { deleteAccountCore } from '../_shared/account.js';
import { isOriginAllowed } from '../_shared/origin.js';
import { adminClient, bearerToken, corsHeaders, json } from '../_shared/edge.ts';

const BUCKET = 'avatars';

Deno.serve(async (req: Request) => {
  const cfg = readConfig(Deno.env.toObject());
  const cors = corsHeaders(req, cfg.allowedOrigins);
  if (!isOriginAllowed(req.headers.get('origin'), cfg.allowedOrigins)) return json({ code: 'origin_not_allowed' }, 403, cors);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json({ code: 'method_not_allowed' }, 405, cors);

  try {
    const body = await req.json().catch(() => ({}));
    const admin: any = adminClient();
    const result = await deleteAccountCore({
      token: bearerToken(req),
      confirm: body?.confirm,
      auth: {
        async getUser(token: string) {
          const { data, error } = await admin.auth.getUser(token);
          return error ? null : data?.user ?? null;
        },
        async deleteUser(id: string) {
          const { error } = await admin.auth.admin.deleteUser(id);
          if (error) throw error;
        },
      },
      storage: {
        // Remove every object in the user's own folder (paged).
        async removeAllFor(userId: string) {
          for (let guard = 0; guard < 50; guard += 1) {
            const { data, error } = await admin.storage.from(BUCKET).list(userId, { limit: 100 });
            if (error) throw error;
            if (!data || data.length === 0) return;
            const { error: removeError } = await admin.storage.from(BUCKET).remove(data.map((o: any) => `${userId}/${o.name}`));
            if (removeError) throw removeError;
          }
          throw new Error('too many avatar objects');
        },
      },
    });
    return json(result.ok ? { ok: true } : { code: result.code }, result.status, cors);
  } catch (err) {
    console.error('delete-account failed:', (err as Error)?.message); // never log tokens
    return json({ code: 'internal' }, 500, cors);
  }
});
