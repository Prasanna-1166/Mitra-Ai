// Profile rows and avatar objects. Row-level security and the storage policies
// guarantee that only the owner can touch either; the user id here only fills
// the owner column and the storage folder.
import { makeId } from '../lib/ids.js';
import { AVATAR_EXT, AVATAR_TYPES, AVATAR_UPLOAD_MAX_BYTES } from '../lib/profile.js';

export const AVATAR_BUCKET = 'avatars';
const SIGNED_URL_SECONDS = 3600;

const check = ({ error }, fallback = 'Request failed') => {
  if (error) {
    const e = new Error(error.message || fallback);
    e.code = error.code;
    throw e;
  }
};

const mapProfile = (row) =>
  row
    ? {
        displayName: row.display_name ?? null,
        avatarPath: row.avatar_path ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null;

const COLS = 'display_name, avatar_path, created_at, updated_at';

export function createProfileStore(supabase, userId, { idFactory = makeId } = {}) {
  const bucket = () => supabase.storage.from(AVATAR_BUCKET);

  const store = {
    async get() {
      const { data, error } = await supabase.from('profiles').select(COLS).eq('user_id', userId).maybeSingle();
      check({ error });
      return mapProfile(data);
    },

    // The sign-up trigger normally creates the row. If it did not (older account,
    // trigger failure) create it here; a concurrent creation is not an error.
    async ensure() {
      const existing = await store.get();
      if (existing) return existing;
      const { error } = await supabase.from('profiles').insert({ user_id: userId });
      if (error && error.code !== '23505') check({ error });
      const created = await store.get();
      if (!created) throw new Error("Your profile couldn't be created.");
      return created;
    },

    async saveDisplayName(displayName) {
      await store.ensure();
      const { data, error } = await supabase
        .from('profiles').update({ display_name: displayName }).eq('user_id', userId).select(COLS).maybeSingle();
      check({ error });
      if (!data) throw new Error("Your profile couldn't be saved.");
      return mapProfile(data);
    },

    // Upload under a NEW unique name, point the profile at it, then delete the old
    // object. A failure at any step leaves the previous avatar intact and does not
    // leave an orphan object behind.
    async uploadAvatar(blob, type, previousPath) {
      if (!AVATAR_TYPES.includes(type)) throw new Error('Use a PNG, JPEG or WebP image.');
      if (!blob || blob.size > AVATAR_UPLOAD_MAX_BYTES) throw new Error('That image is too large.');
      await store.ensure();
      const path = `${userId}/${idFactory()}.${AVATAR_EXT[type]}`;
      const { error: uploadError } = await bucket().upload(path, blob, { contentType: type, upsert: false, cacheControl: '3600' });
      check({ error: uploadError }, 'Upload failed');
      const { data, error } = await supabase
        .from('profiles').update({ avatar_path: path }).eq('user_id', userId).select(COLS).maybeSingle();
      if (error || !data) {
        await bucket().remove([path]).catch(() => {});
        check({ error: error ?? { message: "Your profile couldn't be saved." } });
      }
      if (previousPath && previousPath !== path) await bucket().remove([previousPath]).catch(() => {});
      return mapProfile(data);
    },

    // Clear the reference first (so the UI never points at a deleted file), then
    // delete the object. If the object delete fails the file is merely unreferenced.
    async removeAvatar(previousPath) {
      const { data, error } = await supabase
        .from('profiles').update({ avatar_path: null }).eq('user_id', userId).select(COLS).maybeSingle();
      check({ error });
      if (!data) throw new Error("Your profile couldn't be saved.");
      if (previousPath) await bucket().remove([previousPath]).catch(() => {});
      return mapProfile(data);
    },

    async signedUrl(path) {
      if (!path) return null;
      const { data, error } = await bucket().createSignedUrl(path, SIGNED_URL_SECONDS);
      if (error || !data?.signedUrl) return null;
      return data.signedUrl;
    },
  };
  return store;
}
