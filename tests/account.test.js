import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteAccountCore } from '../supabase/functions/_shared/account.js';
import { isOriginAllowed } from '../supabase/functions/_shared/origin.js';

function deps({ user = { id: 'u1' }, failStorage = false, failDelete = false } = {}) {
  const calls = [];
  return {
    calls,
    auth: {
      async getUser(token) { calls.push(['getUser', token]); return token === 'good' ? user : null; },
      async deleteUser(id) { calls.push(['deleteUser', id]); if (failDelete) throw new Error('x'); },
    },
    storage: { async removeAllFor(id) { calls.push(['removeAllFor', id]); if (failStorage) throw new Error('x'); } },
  };
}

test('account deletion: needs a token and an explicit confirmation, and touches nothing otherwise', async () => {
  for (const args of [{ token: null, confirm: 'DELETE' }, { token: '', confirm: 'DELETE' }, { token: 'good', confirm: 'yes' }, { token: 'good' }]) {
    const d = deps();
    const r = await deleteAccountCore({ ...args, auth: d.auth, storage: d.storage });
    assert.ok([400, 401].includes(r.status), JSON.stringify(args));
    assert.ok(!d.calls.some((c) => c[0] === 'deleteUser' || c[0] === 'removeAllFor'));
  }
});

test('account deletion: an invalid or expired token deletes nothing', async () => {
  const d = deps();
  const r = await deleteAccountCore({ token: 'forged', confirm: 'DELETE', auth: d.auth, storage: d.storage });
  assert.deepEqual([r.status, r.code], [401, 'invalid_session']);
  assert.deepEqual(d.calls, [['getUser', 'forged']]);
  const thrower = { async getUser() { throw new Error('auth down'); }, async deleteUser() { assert.fail('must not delete'); } };
  assert.equal((await deleteAccountCore({ token: 'x', confirm: 'DELETE', auth: thrower, storage: d.storage })).status, 401);
});

test('account deletion: removes avatar objects first, then deletes exactly the verified caller', async () => {
  const d = deps({ user: { id: 'caller-id' } });
  const r = await deleteAccountCore({ token: 'good', confirm: 'DELETE', userId: 'victim-id', body: { userId: 'victim-id' }, auth: d.auth, storage: d.storage });
  assert.deepEqual(r, { status: 200, ok: true });
  assert.deepEqual(d.calls, [['getUser', 'good'], ['removeAllFor', 'caller-id'], ['deleteUser', 'caller-id']]);
  assert.ok(!JSON.stringify(d.calls).includes('victim-id'), 'a user id supplied by the client is never used');
});

test('account deletion: if avatar cleanup fails the account is kept so the user can retry (no orphaned images)', async () => {
  const d = deps({ failStorage: true });
  const r = await deleteAccountCore({ token: 'good', confirm: 'DELETE', auth: d.auth, storage: d.storage });
  assert.deepEqual([r.status, r.code], [500, 'cleanup_failed']);
  assert.ok(!d.calls.some((c) => c[0] === 'deleteUser'));
  const again = deps();
  assert.equal((await deleteAccountCore({ token: 'good', confirm: 'DELETE', auth: again.auth, storage: again.storage })).status, 200);
});

test('account deletion: an auth failure is reported', async () => {
  const d = deps({ failDelete: true });
  const r = await deleteAccountCore({ token: 'good', confirm: 'DELETE', auth: d.auth, storage: d.storage });
  assert.deepEqual([r.status, r.code], [500, 'internal']);
});

test('origin validation: allow-listed origins pass, others are refused, the relay requires an Origin', () => {
  const allowed = ['https://app.example.com', 'http://localhost:5173'];
  assert.equal(isOriginAllowed('https://app.example.com', allowed), true);
  assert.equal(isOriginAllowed('http://localhost:5173', allowed), true);
  assert.equal(isOriginAllowed('https://evil.example', allowed), false);
  assert.equal(isOriginAllowed('https://app.example.com.evil.example', allowed), false);
  assert.equal(isOriginAllowed('HTTPS://APP.EXAMPLE.COM', allowed), false, 'exact match only');
  assert.equal(isOriginAllowed(null, allowed), true, 'non-browser callers are still gated by their token/ticket');
  assert.equal(isOriginAllowed(null, allowed, { requireOrigin: true }), false);
  assert.equal(isOriginAllowed('', allowed, { requireOrigin: true }), false);
  assert.equal(isOriginAllowed('https://anything.example', []), true, 'no list configured = development mode');
  assert.equal(isOriginAllowed(undefined, undefined), true);
});
