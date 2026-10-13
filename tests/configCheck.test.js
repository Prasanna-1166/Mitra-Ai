import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSupabaseConfig } from '../src/lib/configCheck.js';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (role) => `${b64({ alg: 'HS256' })}.${b64({ role })}.signature`;
const good = { url: 'https://abcdefghij.supabase.co', key: 'sb_publishable_abc123' };

test('a valid public configuration passes', () => {
  assert.deepEqual(checkSupabaseConfig(good), { ok: true, problems: [] });
  assert.equal(checkSupabaseConfig({ ...good, key: jwt('anon') }).ok, true, 'the legacy anon JWT is accepted');
  assert.equal(checkSupabaseConfig({ ...good, isProd: true }).ok, true);
});

test('missing variables are named so the fix is obvious', () => {
  const r = checkSupabaseConfig({ url: '', key: '' });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /VITE_SUPABASE_URL is not set/);
  assert.match(r.problems.join(' '), /VITE_SUPABASE_PUBLISHABLE_KEY is not set/);
});

test('placeholders from .env.example are caught', () => {
  assert.match(checkSupabaseConfig({ ...good, url: 'https://YOUR-PROJECT-REF.supabase.co' }).problems[0], /placeholder/);
  assert.equal(checkSupabaseConfig({ ...good, key: 'your-key-here' }).ok, false);
});

test('a service-role or secret key in a VITE_ variable is refused and never echoed', () => {
  for (const key of ['sb_secret_abcdef123456', jwt('service_role')]) {
    const r = checkSupabaseConfig({ ...good, key });
    assert.equal(r.ok, false);
    assert.match(r.problems[0], /secret \(service-role\) key/);
    assert.match(r.problems[0], /rotate/);
    assert.ok(!r.problems.join(' ').includes(key), 'the key value is not repeated in the message');
  }
});

test('production builds reject localhost and plain-http Supabase URLs', () => {
  assert.equal(checkSupabaseConfig({ ...good, url: 'http://localhost:54321', isProd: true }).ok, false);
  assert.equal(checkSupabaseConfig({ ...good, url: 'http://127.0.0.1:54321', isProd: true }).ok, false);
  assert.equal(checkSupabaseConfig({ ...good, url: 'http://abc.supabase.co', isProd: true }).ok, false);
  assert.equal(checkSupabaseConfig({ ...good, url: 'http://localhost:54321', isProd: false }).ok, true, 'local development is fine');
  assert.equal(checkSupabaseConfig({ ...good, url: 'not a url' }).ok, false);
  assert.equal(checkSupabaseConfig({ ...good, url: 'ftp://x.y' }).ok, false);
});
