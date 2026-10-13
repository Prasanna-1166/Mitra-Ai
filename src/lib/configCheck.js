// Early validation of the public frontend configuration. Messages name the variable
// and the problem, and never echo the value of a key.

function jwtRole(key) {
  const parts = key.split('.');
  if (parts.length !== 3) return null;
  try {
    const json = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json).role ?? null;
  } catch {
    return null;
  }
}

export function checkSupabaseConfig({ url, key, isProd = false }) {
  const problems = [];
  if (!url) problems.push('VITE_SUPABASE_URL is not set.');
  else if (/YOUR-PROJECT-REF|your-project/i.test(url)) problems.push('VITE_SUPABASE_URL still contains the placeholder from .env.example. Use your real Project URL.');
  else {
    let parsed = null;
    try {
      parsed = new URL(url);
    } catch {
      parsed = null;
    }
    if (!parsed || !/^https?:$/.test(parsed.protocol)) problems.push('VITE_SUPABASE_URL is not a valid http(s) URL.');
    else if (isProd && /^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(parsed.hostname)) problems.push('VITE_SUPABASE_URL points to a local address in a production build.');
    else if (isProd && parsed.protocol !== 'https:') problems.push('VITE_SUPABASE_URL must use https in production.');
  }
  if (!key) problems.push('VITE_SUPABASE_PUBLISHABLE_KEY is not set.');
  else if (key.startsWith('sb_secret_') || jwtRole(key) === 'service_role') {
    problems.push('VITE_SUPABASE_PUBLISHABLE_KEY contains a secret (service-role) key. It was NOT used. Remove it, rotate that key in the Supabase dashboard, and use the publishable key.');
  } else if (/^your-|placeholder/i.test(key)) problems.push('VITE_SUPABASE_PUBLISHABLE_KEY still contains a placeholder.');
  return { ok: problems.length === 0, problems };
}
