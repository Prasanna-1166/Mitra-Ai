// Account deletion, with every external effect injected so it can be tested.
//
// Order matters: avatar objects are removed first. If that fails the account is
// NOT deleted and the user can simply retry, so no personal image is ever orphaned
// by an account that no longer exists. Once the Auth user is deleted, foreign keys
// with ON DELETE CASCADE remove the profile, conversations, messages, memories,
// settings, tickets and usage records. Storage and Postgres cannot share one
// transaction, which is why the cleanup runs first and is retry-safe.
//
// The user id comes ONLY from the verified token, never from the request body.
export async function deleteAccountCore({ token, confirm, auth, storage }) {
  if (!token) return { status: 401, code: 'unauthorized' };
  if (confirm !== 'DELETE') return { status: 400, code: 'confirmation_required' };

  let user = null;
  try {
    user = await auth.getUser(token);
  } catch {
    user = null;
  }
  if (!user?.id) return { status: 401, code: 'invalid_session' };

  try {
    await storage.removeAllFor(user.id);
  } catch {
    return { status: 500, code: 'cleanup_failed' };
  }
  try {
    await auth.deleteUser(user.id);
  } catch {
    return { status: 500, code: 'internal' };
  }
  return { status: 200, ok: true };
}
