// Pure profile helpers: validation and display fallbacks.

export const DISPLAY_NAME_MAX = 50;
export const AVATAR_INPUT_MAX_BYTES = 5 * 1024 * 1024; // what a user may pick
export const AVATAR_UPLOAD_MAX_BYTES = 2 * 1024 * 1024; // matches the bucket limit
export const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
export const AVATAR_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

// Returns { ok: true, value } (value is null when the name is cleared) or { ok: false, error }.
export function validateDisplayName(raw) {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: 'Enter a valid name.' };
  const value = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (value.length === 0) return { ok: true, value: null };
  if (Array.from(value).length > DISPLAY_NAME_MAX) {
    return { ok: false, error: `Use ${DISPLAY_NAME_MAX} characters or fewer.` };
  }
  return { ok: true, value };
}

// file: { type, size } (a File works). Returns an error message or null.
export function validateAvatarFile(file) {
  if (!file || typeof file.size !== 'number') return 'Choose an image file.';
  if (!AVATAR_TYPES.includes(file.type)) return 'Use a PNG, JPEG or WebP image.';
  if (file.size === 0) return 'That file is empty.';
  if (file.size > AVATAR_INPUT_MAX_BYTES) return 'Choose an image under 5 MB.';
  return null;
}

export function defaultDisplayName(email) {
  const local = (email ?? '').split('@')[0].trim();
  return local || 'Account';
}

// Display name shown in the UI: saved name, otherwise the email's local part.
export function displayNameOf(profile, user) {
  return profile?.displayName || defaultDisplayName(user?.email);
}

export function initialOf(name) {
  const first = Array.from((name ?? '').trim())[0];
  return first ? first.toUpperCase() : '?';
}
