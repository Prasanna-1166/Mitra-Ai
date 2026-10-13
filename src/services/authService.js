// Thin wrappers over Supabase Auth. Passwords go straight to Supabase Auth; the
// app never stores or hashes them.

export const PASSWORD_MIN_LENGTH = 8;

// Mirrors supabase/config.toml (minimum_password_length / password_requirements).
export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
    return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return 'Include at least one letter and one number.';
  return null;
}

export function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((email ?? '').trim()) ? null : 'Enter a valid email address.';
}

// Generic, non-revealing messages (no "that email is not registered").
export function friendlyAuthError(error) {
  const msg = `${error?.message ?? ''}`.toLowerCase();
  const code = error?.code ?? '';
  if (code === 'invalid_credentials' || msg.includes('invalid login')) return 'Email or password is incorrect.';
  if (code === 'email_not_confirmed' || msg.includes('not confirmed')) return 'Please confirm your email first. Check your inbox for the verification link.';
  if (code === 'weak_password' || msg.includes('password should')) return 'That password is too weak. Use at least 8 characters with letters and numbers.';
  if (code === 'over_request_rate_limit' || code === 'over_email_send_rate_limit' || msg.includes('rate limit')) return 'Too many attempts. Please wait a few minutes and try again.';
  if (code === 'same_password') return 'Choose a password different from your current one.';
  if (code === 'user_already_exists') return 'Could not create the account. Try signing in instead.';
  if (msg.includes('fetch') || msg.includes('network')) return 'Network problem. Check your connection and try again.';
  return 'Something went wrong. Please try again.';
}

export function createAuthService(supabase, { redirectTo } = {}) {
  const wrap = async (fn) => {
    const { data, error } = await fn();
    if (error) {
      const e = new Error(friendlyAuthError(error));
      e.code = error.code;
      throw e;
    }
    return data;
  };
  return {
    // displayName (optional) travels as user metadata; the sign-up trigger copies it into the profile.
    signUp: (email, password, displayName = null) =>
      wrap(() =>
        supabase.auth.signUp({
          email: email.trim(),
          password,
          options: { emailRedirectTo: redirectTo, ...(displayName ? { data: { display_name: displayName } } : {}) },
        }),
      ),
    signIn: (email, password) => wrap(() => supabase.auth.signInWithPassword({ email: email.trim(), password })),
    signOut: () => wrap(() => supabase.auth.signOut()),
    requestPasswordReset: (email) =>
      wrap(() => supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo })),
    updatePassword: (password) => wrap(() => supabase.auth.updateUser({ password })),
    getSession: async () => (await supabase.auth.getSession()).data.session,
    onAuthStateChange: (cb) => supabase.auth.onAuthStateChange(cb).data.subscription,
  };
}

// Server-side deletion: the Edge Function removes the Auth user and, through
// ON DELETE CASCADE, every row the account owns.
export async function deleteAccount({ url, publishableKey, accessToken, fetchImpl }) {
  const doFetch = fetchImpl ?? ((...a) => globalThis.fetch(...a));
  const response = await doFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: publishableKey, Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ confirm: 'DELETE' }),
  });
  if (!response.ok) throw new Error('The account could not be deleted. Please try again.');
}
