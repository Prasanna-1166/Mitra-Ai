import { createClient } from '@supabase/supabase-js';

// Public, browser-safe settings. The publishable key is NOT a secret and is only
// safe because row-level security protects every table. Never put a service-role
// key (or any private key) in a VITE_* variable.
const env = import.meta.env ?? {};
export const supabaseUrl = env.VITE_SUPABASE_URL || '';
const publishableKey = env.VITE_SUPABASE_PUBLISHABLE_KEY || '';

export const isBackendConfigured = Boolean(supabaseUrl && publishableKey);
export const supabasePublishableKey = publishableKey;

// The official client owns the session (storage, refresh, expiry). Tokens are
// never copied into custom storage by this app.
export const supabase = isBackendConfigured
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
