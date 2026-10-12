import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeSupabase } from './fakeSupabase.js';
import {
  createProfileStore,
  validateDisplayName,
  validateAvatarFile,
  MAX_NAME_LENGTH,
  MAX_AVATAR_BYTES,
} from '../src/services/profileService.js';

const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

test('validateDisplayName accepts valid names and rejects invalid input', () => {
  assert.equal(validateDisplayName('Alice'), null);
  assert.equal(validateDisplayName('  Bob  '), null);
  assert.equal(validateDisplayName('A'), null);
  assert.equal(validateDisplayName('X'.repeat(MAX_NAME_LENGTH)), null);

  assert.match(validateDisplayName(''), /Enter a display name/);
  assert.match(validateDisplayName('   '), /Enter a display name/);
  assert.match(validateDisplayName(null), /Enter a display name/);
  assert.match(validateDisplayName(undefined), /Enter a display name/);
  assert.match(validateDisplayName('X'.repeat(MAX_NAME_LENGTH + 1)), /60 characters or less/);
  assert.match(validateDisplayName('Name\u0000Injection'), /control characters/);
});

test('validateAvatarFile accepts valid image types under 2MB and rejects invalid input', () => {
  const validJpg = { name: 'photo.jpg', type: 'image/jpeg', size: 1024 * 1024 };
  const validPng = { name: 'photo.png', type: 'image/png', size: 500 * 1024 };
  const validWebp = { name: 'photo.webp', type: 'image/webp', size: 2 * 1024 * 1024 }; // exactly 2MB
  const validGif = { name: 'photo.gif', type: 'image/gif', size: 100 * 1024 };

  assert.equal(validateAvatarFile(validJpg), null);
  assert.equal(validateAvatarFile(validPng), null);
  assert.equal(validateAvatarFile(validWebp), null);
  assert.equal(validateAvatarFile(validGif), null);

  assert.match(validateAvatarFile(null), /Select an image file/);
  assert.match(validateAvatarFile({ name: 'doc.pdf', type: 'application/pdf', size: 1024 }), /Choose a JPEG, PNG, WebP, or GIF/);
  assert.match(validateAvatarFile({ name: 'code.svg', type: 'image/svg+xml', size: 1024 }), /Choose a JPEG, PNG, WebP, or GIF/);
  assert.match(validateAvatarFile({ name: 'huge.jpg', type: 'image/jpeg', size: MAX_AVATAR_BYTES + 1 }), /smaller than 2 MB/);
});

test('profile store: getProfile returns existing profile or auto-creates fallback', async () => {
  const db = new FakeSupabase();
  db.uid = USER_A;
  const storeA = createProfileStore(db, USER_A);

  // Initial fetch auto-creates with fallback email prefix
  const initial = await storeA.getProfile('alice@example.com');
  assert.equal(initial.id, USER_A);
  assert.equal(initial.display_name, 'alice');
  assert.equal(initial.avatar_url, null);

  // Subsequent fetch retrieves the stored profile
  const stored = await storeA.getProfile('alice@example.com');
  assert.equal(stored.id, USER_A);
  assert.equal(stored.display_name, 'alice');
});

test('profile store: updateDisplayName updates persistent record', async () => {
  const db = new FakeSupabase();
  db.uid = USER_A;
  const storeA = createProfileStore(db, USER_A);
  await storeA.getProfile('alice@example.com');

  const updated = await storeA.updateDisplayName('Alice Wonder');
  assert.equal(updated.display_name, 'Alice Wonder');

  const reloaded = await storeA.getProfile('alice@example.com');
  assert.equal(reloaded.display_name, 'Alice Wonder');
});

test('profile store: uploadAvatar stores file in private bucket and sets avatar_url', async () => {
  const db = new FakeSupabase();
  db.uid = USER_A;
  const storeA = createProfileStore(db, USER_A);
  await storeA.getProfile('alice@example.com');

  const file1 = { name: 'me.png', type: 'image/png', size: 2048 };
  const { profile, signedUrl } = await storeA.uploadAvatar(file1, null);

  assert.ok(profile.avatar_url.startsWith(`${USER_A}/avatar-`));
  assert.ok(profile.avatar_url.endsWith('.png'));
  assert.match(signedUrl, /^https:\/\/fake-storage\.supabase\.co\/avatars\//);
  assert.ok(db.storage.buckets.avatars[profile.avatar_url]);

  // Replacing avatar cleans up the previous object
  const oldPath = profile.avatar_url;
  const file2 = { name: 'new.jpg', type: 'image/jpeg', size: 4096 };
  const { profile: nextProfile, signedUrl: nextSignedUrl } = await storeA.uploadAvatar(file2, oldPath);

  assert.notEqual(nextProfile.avatar_url, oldPath);
  assert.equal(db.storage.buckets.avatars[oldPath], undefined, 'old avatar is cleaned up');
  assert.ok(db.storage.buckets.avatars[nextProfile.avatar_url]);
  assert.match(nextSignedUrl, /^https:\/\/fake-storage\.supabase\.co\/avatars\//);
});

test('profile store: removeAvatar removes object from storage and nullifies avatar_url', async () => {
  const db = new FakeSupabase();
  db.uid = USER_A;
  const storeA = createProfileStore(db, USER_A);
  await storeA.getProfile('alice@example.com');

  const file = { name: 'avatar.webp', type: 'image/webp', size: 1024 };
  const { profile } = await storeA.uploadAvatar(file, null);
  const avatarPath = profile.avatar_url;
  assert.ok(db.storage.buckets.avatars[avatarPath]);

  const cleared = await storeA.removeAvatar(avatarPath);
  assert.equal(cleared.avatar_url, null);
  assert.equal(db.storage.buckets.avatars[avatarPath], undefined, 'storage object removed');

  const reloaded = await storeA.getProfile('alice@example.com');
  assert.equal(reloaded.avatar_url, null);
});

test('profile store: account isolation prevents cross-account access and modifications', async () => {
  const db = new FakeSupabase();
  db.uid = USER_A;
  const storeA = createProfileStore(db, USER_A);
  await storeA.getProfile('alice@example.com');
  await storeA.updateDisplayName('Alice Verified');

  // Switch to User B
  db.uid = USER_B;
  const storeB = createProfileStore(db, USER_B);
  const profileB = await storeB.getProfile('bob@example.com');
  assert.equal(profileB.id, USER_B);
  assert.equal(profileB.display_name, 'bob');

  // User B cannot see User A's profile rows
  const bRows = db.rowsOf('profiles', USER_B);
  assert.equal(bRows.length, 1);
  assert.equal(bRows[0].id, USER_B);

  // Attempting to forge User A's profile update under User B fails
  const rogueStore = createProfileStore(db, USER_A);
  await assert.rejects(() => rogueStore.updateDisplayName('Hacked Name'), /expected one row|permission denied|violates row-level security/);
});
