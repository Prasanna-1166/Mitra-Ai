import { createClient } from '@supabase/supabase-js';
import { checkSupabaseConfig } from './configCheck.js';

// Public, browser-safe settings. The publishable key is NOT a secret and is only
// safe because row-level security protects every table. Never put a service-role
// key (or any private key) in a VITE_* variable: such a key is detected and refused.
const env = import.meta.env ?? {};
export const supabaseUrl = env.VITE_SUPABASE_URL || '';
const publishableKey = env.VITE_SUPABASE_PUBLISHABLE_KEY || '';

const check = checkSupabaseConfig({ url: supabaseUrl, key: publishableKey, isProd: Boolean(env.PROD) });
export const configProblems = check.problems;
export const isBackendConfigured = check.ok;
export const supabasePublishableKey = check.ok ? publishableKey : '';

// The official client owns the session (storage, refresh, expiry). Tokens are
// never copied into custom storage by this app.
export const supabase = check.ok
  ? createClient(supabaseUrl, publishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null;

export function functionUrl(name) {
  return `${supabaseUrl.replace(/\/$/, '')}/functions/v1/${name}`;
}

export function relayUrl() {
  return functionUrl('chat-relay').replace(/^http/, 'ws');
}
