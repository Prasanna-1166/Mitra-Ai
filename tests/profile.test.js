import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeSupabase } from './fakeSupabase.js';
import { createProfileStore } from '../src/services/profileService.js';
import { ProfileManager } from '../src/lib/profileManager.js';
import {
  AVATAR_INPUT_MAX_BYTES, defaultDisplayName, displayNameOf, initialOf, validateAvatarFile, validateDisplayName,
} from '../src/lib/profile.js';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 8; i += 1) await tick(); };
const png = (size = 1000) => ({ size, type: 'image/png' });
let n = 0;
const idFactory = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

// The database trigger creates the row at sign-up; emulate it.
function withProfile(db, uid, extra = {}) {
  db.uid = uid;
  db.tables.profiles.push({ user_id: uid, display_name: null, avatar_path: null, created_at: db.now(), updated_at: db.now(), ...extra });
}

// ---------------------------------------------------------------- validation
test('display names are trimmed, collapsed, bounded; clearing is allowed', () => {
  assert.deepEqual(validateDisplayName('  Ada   Lovelace '), { ok: true, value: 'Ada Lovelace' });
  assert.deepEqual(validateDisplayName('   '), { ok: true, value: null });
  assert.deepEqual(validateDisplayName(null), { ok: true, value: null });
  assert.deepEqual(validateDisplayName('Zoë\n\tK'), { ok: true, value: 'Zoë K' });
  assert.equal(validateDisplayName('x'.repeat(51)).ok, false);
  assert.equal(validateDisplayName('x'.repeat(50)).ok, true);
  assert.equal(validateDisplayName('😀'.repeat(50)).ok, true, 'length counts characters, not UTF-16 units');
  assert.equal(validateDisplayName(42).ok, false);
});

test('avatar files: only png/jpeg/webp, non-empty, under 5 MB', () => {
  assert.equal(validateAvatarFile(png()), null);
  assert.equal(validateAvatarFile({ size: 10, type: 'image/jpeg' }), null);
  assert.equal(validateAvatarFile({ size: 10, type: 'image/webp' }), null);
  assert.match(validateAvatarFile({ size: 10, type: 'image/gif' }), /PNG, JPEG or WebP/);
  assert.match(validateAvatarFile({ size: 10, type: 'image/svg+xml' }), /PNG, JPEG or WebP/);
  assert.match(validateAvatarFile({ size: 10, type: 'application/pdf' }), /PNG, JPEG or WebP/);
  assert.match(validateAvatarFile({ size: 0, type: 'image/png' }), /empty/);
  assert.match(validateAvatarFile({ size: AVATAR_INPUT_MAX_BYTES + 1, type: 'image/png' }), /under 5 MB/);
  assert.match(validateAvatarFile(null), /Choose an image/);
});

test('display fallbacks use the email local part and the initial', () => {
  assert.equal(defaultDisplayName('ada.l@example.com'), 'ada.l');
  assert.equal(defaultDisplayName(''), 'Account');
  assert.equal(displayNameOf({ displayName: 'Ada' }, { email: 'x@y.z' }), 'Ada');
  assert.equal(displayNameOf({ displayName: null }, { email: 'x@y.z' }), 'x');
  assert.equal(initialOf('ada'), 'A');
  assert.equal(initialOf('😀 smile'), '😀');
  assert.equal(initialOf(''), '?');
});

// --------------------------------------------------------------------- store
test('profile: ensure() creates a missing row (trigger fallback) and is idempotent', async () => {
  const db = new FakeSupabase();
  db.uid = A;
  const store = createProfileStore(db, A, { idFactory });
  assert.equal(await store.get(), null);
  const created = await store.ensure();
  assert.deepEqual([created.displayName, created.avatarPath], [null, null]);
  await store.ensure();
  assert.equal(db.tables.profiles.length, 1);
});

test('profile: display name persists, validates at the database, and is readable after a "reload"', async () => {
  const db = new FakeSupabase();
  withProfile(db, A);
  const store = createProfileStore(db, A, { idFactory });
  const saved = await store.saveDisplayName('Ada');
  assert.equal(saved.displayName, 'Ada');
  assert.equal((await createProfileStore(db, A).get()).displayName, 'Ada');
  await assert.rejects(() => store.saveDisplayName('x'.repeat(51)), /profiles_display_name_check/);
  assert.equal((await store.get()).displayName, 'Ada', 'a rejected save changes nothing');
  assert.equal((await store.saveDisplayName(null)).displayName, null);
});

test('avatar: upload stores a private object in the user\'s folder and a signed URL resolves it', async () => {
  const db = new FakeSupabase();
  withProfile(db, A);
  const store = createProfileStore(db, A, { idFactory });
  const p = await store.uploadAvatar(png(), 'image/png', null);
  assert.match(p.avatarPath, new RegExp(`^${A}/[0-9a-f-]{36}\\.png$`));
  assert.ok(db.objects.has(p.avatarPath));
  const url = await store.signedUrl(p.avatarPath);
  assert.match(url, /^https:\/\/storage\.test\/sign\/avatars\//);
  assert.equal(await store.signedUrl(null), null);
});

test('avatar: replacing uploads first, repoints the profile, then deletes the old object', async () => {
  const db = new FakeSupabase();
  withProfile(db, A);
  const store = createProfileStore(db, A, { idFactory });
  const first = await store.uploadAvatar(png(), 'image/png', null);
  const second = await store.uploadAvatar(png(), 'image/webp', first.avatarPath);
  assert.notEqual(first.avatarPath, second.avatarPath);
  assert.equal(db.objects.has(first.avatarPath), false, 'the replaced object is cleaned up');
  assert.equal(db.objects.has(second.avatarPath), true);
  assert.equal([...db.objects.keys()].length, 1);
  assert.equal(db.tables.profiles[0].avatar_path, second.avatarPath);
});

test('avatar: a failed upload keeps the previous avatar; a failed profile update removes the new object', async () => {
  const db = new FakeSupabase();
  withProfile(db, A);
  const store = createProfileStore(db, A, { idFactory });
  const first = await store.uploadAvatar(png(), 'image/png', null);

  db.storageFail = { op: 'upload' };
  await assert.rejects(() => store.uploadAvatar(png(), 'image/png', first.avatarPath));
  assert.equal(db.tables.profiles[0].avatar_path, first.avatarPath);
  assert.equal(db.objects.size, 1);

  db.failNext = { table: 'profiles', op: 'update' };
  await assert.rejects(() => store.uploadAvatar(png(), 'image/png', first.avatarPath));
  assert.equal(db.tables.profiles[0].avatar_path, first.avatarPath);
  assert.equal(db.objects.size, 1, 'the orphan object was removed');
  assert.ok(db.objects.has(first.avatarPath));
});

test('avatar: removal clears the reference then deletes the object; a failed delete leaves the profile consistent', async () => {
  const db = new FakeSupabase();
  withProfile(db, A);
  const store = createProfileStore(db, A, { idFactory });
  const up = await store.uploadAvatar(png(), 'image/png', null);
  const removed = await store.removeAvatar(up.avatarPath);
  assert.equal(removed.avatarPath, null);
  assert.equal(db.objects.size, 0);

  const up2 = await store.uploadAvatar(png(), 'image/png', null);
  db.storageFail = { op: 'remove' };
  const r2 = await store.removeAvatar(up2.avatarPath);
  assert.equal(r2.avatarPath, null, 'the profile no longer points at the file even if cleanup failed');
});

test('avatar: wrong types and oversize files are rejected before upload; the bucket enforces them too', async () => {
  const db = new FakeSupabase();
  withProfile(db, A);
  const store = createProfileStore(db, A, { idFactory });
  await assert.rejects(() => store.uploadAvatar(png(), 'image/gif', null), /PNG, JPEG or WebP/);
  await assert.rejects(() => store.uploadAvatar({ size: 3 * 1024 * 1024 }, 'image/png', null), /too large/);
  const { error } = await db.storage.from('avatars').upload(`${A}/x.png`, { size: 10 }, { contentType: 'application/pdf' });
  assert.match(error.message, /mime/);
  const big = await db.storage.from('avatars').upload(`${A}/y.png`, { size: 3 * 1024 * 1024 }, { contentType: 'image/png' });
  assert.match(big.error.message, /maximum allowed size/);
  assert.equal(db.objects.size, 0);
});

test('isolation: B cannot read, edit, repoint or sign A\'s profile and avatar', async () => {
  const db = new FakeSupabase();
  withProfile(db, A, { display_name: 'Ada' });
  const storeA = createProfileStore(db, A, { idFactory });
  const avatarA = await storeA.uploadAvatar(png(), 'image/png', null);

  withProfile(db, B, { display_name: 'Bea' });
  const storeB = createProfileStore(db, B, { idFactory });
  assert.equal((await storeB.get()).displayName, 'Bea', 'B only ever sees their own row');
  // B tries to act on A's row by id
  const hack = await db.from('profiles').update({ display_name: 'hacked' }).eq('user_id', A).select();
  assert.deepEqual(hack.data, []);
  assert.equal(db.tables.profiles.find((r) => r.user_id === A).display_name, 'Ada');
  // B cannot point their own profile at A's avatar object
  const steal = await db.from('profiles').update({ avatar_path: avatarA.avatarPath }).eq('user_id', B).select();
  assert.match(steal.error.message, /avatar_path_check/);
  // nor sign, delete, or write into A's folder
  assert.equal(await storeB.signedUrl(avatarA.avatarPath), null);
  assert.deepEqual((await db.storage.from('avatars').remove([avatarA.avatarPath])).data, []);
  assert.ok(db.objects.has(avatarA.avatarPath));
  assert.match((await db.storage.from('avatars').upload(`${A}/evil.png`, png(), { contentType: 'image/png' })).error.message, /row-level security/);
  // changing ownership is impossible
  const own = await db.from('profiles').update({ user_id: A }).eq('user_id', B).select();
  assert.match(own.error.message, /permission denied/);
  // an external URL can never become an avatar
  const ext = await db.from('profiles').update({ avatar_path: 'https://evil.example/a.png' }).eq('user_id', B).select();
  assert.match(ext.error.message, /avatar_path_check/);
});

test('unauthenticated clients can do nothing', async () => {
  const db = new FakeSupabase();
  withProfile(db, A);
  db.uid = null;
  assert.match((await db.from('profiles').select('*')).error.message, /permission denied/);
  assert.match((await db.storage.from('avatars').upload(`${A}/x.png`, png(), { contentType: 'image/png' })).error.message, /row-level/);
});

// ------------------------------------------------------------------- manager
function manager(db, { processImage } = {}) {
  return new ProfileManager({
    createStore: (uid) => { db.uid = uid; return createProfileStore(db, uid, { idFactory }); },
    processImage: processImage ?? (async () => ({ blob: { size: 500 }, type: 'image/webp' })),
  });
}

test('manager: loads (creating a missing profile), exposes the avatar URL, and clears on sign-out', async () => {
  const db = new FakeSupabase();
  withProfile(db, A, { display_name: 'Ada' });
  const m = manager(db);
  m.setUser(A);
  assert.equal(m.getState().status, 'loading');
  await settle();
  assert.deepEqual([m.getState().status, m.getState().profile.displayName], ['ready', 'Ada']);
  m.setUser(null);
  assert.deepEqual(m.getState(), { ownerId: null, status: 'idle', profile: null, avatarUrl: null, saving: false, error: null });
});

test('manager: success is reported only after the backend confirmed; failures leave the profile unchanged', async () => {
  const db = new FakeSupabase();
  withProfile(db, A, { display_name: 'Ada' });
  const m = manager(db);
  m.setUser(A);
  await settle();

  db.failNext = { table: 'profiles', op: 'update' };
  const failed = await m.saveDisplayName('New name');
  assert.equal(failed.ok, false);
  assert.match(failed.error, /couldn't be saved/);
  assert.equal(m.getState().profile.displayName, 'Ada');
  assert.equal(m.getState().saving, false);

  assert.equal((await m.saveDisplayName('  New   name ')).ok, true);
  assert.equal(m.getState().profile.displayName, 'New name');
  assert.equal(db.tables.profiles[0].display_name, 'New name');
  assert.equal((await m.saveDisplayName('x'.repeat(60))).ok, false);
});

test('manager: avatar upload, replace and remove; invalid files never reach the processor; failures do not claim success', async () => {
  const db = new FakeSupabase();
  withProfile(db, A);
  let processed = 0;
  const m = manager(db, { processImage: async () => { processed += 1; return { blob: { size: 800 }, type: 'image/webp' }; } });
  m.setUser(A);
  await settle();

  const bad = await m.uploadAvatar({ size: 10, type: 'image/gif' });
  assert.equal(bad.ok, false);
  assert.equal(processed, 0);

  assert.equal((await m.uploadAvatar(png())).ok, true);
  const firstPath = m.getState().profile.avatarPath;
  assert.match(m.getState().avatarUrl, /^https:\/\/storage\.test\//);
  assert.equal((await m.uploadAvatar(png())).ok, true);
  assert.notEqual(m.getState().profile.avatarPath, firstPath);
  assert.equal(db.objects.size, 1);

  db.storageFail = { op: 'upload' };
  const keptPath = m.getState().profile.avatarPath;
  const failed = await m.uploadAvatar(png());
  assert.equal(failed.ok, false);
  assert.equal(m.getState().profile.avatarPath, keptPath, 'UI state still shows the previous avatar');

  assert.equal((await m.removeAvatar()).ok, true);
  assert.deepEqual([m.getState().profile.avatarPath, m.getState().avatarUrl, db.objects.size], [null, null, 0]);
  assert.equal((await m.removeAvatar()).ok, false);
});

test('manager: an unreadable image is reported with a clear message', async () => {
  const db = new FakeSupabase();
  withProfile(db, A);
  const m = manager(db, { processImage: async () => { throw new Error("That file couldn't be read as an image."); } });
  m.setUser(A);
  await settle();
  const r = await m.uploadAvatar(png());
  assert.deepEqual([r.ok, r.error], [false, "That file couldn't be read as an image."]);
  assert.equal(db.objects.size, 0);
});

test('manager: load errors are visible and retry recovers', async () => {
  const db = new FakeSupabase();
  withProfile(db, A, { display_name: 'Ada' });
  const m = manager(db);
  db.failNext = { table: 'profiles', op: 'select' };
  m.setUser(A);
  await settle();
  assert.equal(m.getState().status, 'error');
  assert.match(m.getState().error, /couldn't be loaded/);
  await m.load();
  assert.deepEqual([m.getState().status, m.getState().profile.displayName], ['ready', 'Ada']);
});

test('account switching: the previous profile is cleared at once and late results never repopulate it', async () => {
  const db = new FakeSupabase();
  withProfile(db, A, { display_name: 'Ada' });
  withProfile(db, B, { display_name: 'Bea' });
  const gates = [];
  const m = new ProfileManager({
    createStore: (uid) => {
      const real = createProfileStore(db, uid, { idFactory });
      return { ...real, ensure: () => new Promise((resolve) => gates.push(() => { db.uid = uid; real.ensure().then(resolve); })), signedUrl: real.signedUrl };
    },
    processImage: async () => ({ blob: { size: 1 }, type: 'image/png' }),
  });
  m.setUser(A);
  m.setUser(B); // A signs out and B signs in before A's response returns
  assert.equal(m.getState().profile, null);
  gates[0](); // A's late response
  await settle();
  assert.equal(m.getState().profile, null, 'A\'s profile is discarded');
  assert.equal(m.getState().ownerId, B);
  gates[1]();
  await settle();
  assert.equal(m.getState().profile.displayName, 'Bea');
  assert.ok(!JSON.stringify(m.getState()).includes('Ada'));
});

test('account switching: a save that completes after sign-out does not touch the new state', async () => {
  const db = new FakeSupabase();
  withProfile(db, A, { display_name: 'Ada' });
  const m = manager(db);
  m.setUser(A);
  await settle();
  const pending = m.saveDisplayName('Ada 2');
  m.setUser(null);
  const r = await pending;
  assert.equal(r.ok, false);
  assert.equal(m.getState().profile, null);
});
