// Profile service: display names, avatar management, and validation.
// Row-level security protects the profiles table and the avatars storage bucket.

export const MAX_NAME_LENGTH = 60;
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024; // 2 MB
export const ALLOWED_AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export function validateDisplayName(name) {
  if (typeof name !== 'string') return 'Enter a display name.';
  const trimmed = name.trim();
  if (trimmed.length === 0) return 'Enter a display name.';
  if (trimmed.length > MAX_NAME_LENGTH) return `Display name must be ${MAX_NAME_LENGTH} characters or less.`;
  // Disallow control characters
  for (let i = 0; i < trimmed.length; i += 1) {
    const code = trimmed.charCodeAt(i);
    if ((code >= 0 && code <= 31) || code === 127) {
      return 'Display name cannot contain control characters.';
    }
  }
  return null;
}

export function validateAvatarFile(file) {
  if (!file) return 'Select an image file to upload.';
  if (!ALLOWED_AVATAR_TYPES.includes(file.type)) {
    return 'Choose a JPEG, PNG, WebP, or GIF image.';
  }
  if (file.size > MAX_AVATAR_BYTES) {
    return 'Image must be smaller than 2 MB.';
  }
  return null;
}

const check = ({ error }) => {
  if (error) {
    const e = new Error(error.message || 'Database error');
    e.code = error.code;
    throw e;
  }
};

export function createProfileStore(supabase, userId) {
  return {
    async getProfile(fallbackEmail) {
      if (!userId || !supabase) return null;
      const { data, error } = await supabase
        .from('profiles')
        .select('id, display_name, avatar_url, created_at, updated_at')
        .eq('id', userId)
        .maybeSingle();

      if (error && error.code !== 'PGRST116') check({ error });

      if (!data) {
        // If not initialized yet, create initial profile row idempotently
        const defaultName = fallbackEmail ? fallbackEmail.split('@')[0].slice(0, MAX_NAME_LENGTH) : 'User';
        const { data: created, error: insertError } = await supabase
          .from('profiles')
          .insert({ id: userId, display_name: defaultName })
          .select('id, display_name, avatar_url, created_at, updated_at')
          .maybeSingle();

        if (!insertError && created) return created;
        return { id: userId, display_name: defaultName, avatar_url: null };
      }

      return data;
    },

    async updateDisplayName(displayName) {
      const err = validateDisplayName(displayName);
      if (err) throw new Error(err);
      const clean = displayName.trim();
      const { data, error } = await supabase
        .from('profiles')
        .update({ display_name: clean })
        .eq('id', userId)
        .select('id, display_name, avatar_url, created_at, updated_at')
        .single();
      check({ error });
      return data;
    },

    async uploadAvatar(file, currentAvatarPath) {
      const validationError = validateAvatarFile(file);
      if (validationError) throw new Error(validationError);

      const ext = file.name ? file.name.split('.').pop()?.toLowerCase() : 'jpg';
      const safeExt = ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext) ? ext : 'jpg';
      const path = `${userId}/avatar-${Date.now()}.${safeExt}`;

      // Upload file to the private avatars bucket
      const { error: uploadError } = await supabase.storage
        .from('avatars')
        .upload(path, file, { upsert: true, contentType: file.type });
      if (uploadError) throw new Error(uploadError.message || 'Failed to upload avatar image.');

      // Update the profile row
      const { data, error: updateError } = await supabase
        .from('profiles')
        .update({ avatar_url: path })
        .eq('id', userId)
        .select('id, display_name, avatar_url, created_at, updated_at')
        .single();
      if (updateError) {
        // Try to clean up the newly uploaded orphaned file
        try {
          await supabase.storage.from('avatars').remove([path]);
        } catch {
          /* ignore */
        }
        check({ error: updateError });
      }

      // Safely clean up previous avatar file if one existed and is different
      if (currentAvatarPath && currentAvatarPath !== path) {
        try {
          await supabase.storage.from('avatars').remove([currentAvatarPath]);
        } catch {
          /* ignore */
        }
      }

      // Generate signed URL
      const signedUrl = await this.getAvatarUrl(path);
      return { profile: data, signedUrl };
    },

    async removeAvatar(currentAvatarPath) {
      if (currentAvatarPath) {
        try {
          await supabase.storage.from('avatars').remove([currentAvatarPath]);
        } catch {
          /* ignore */
        }
      }
      const { data, error } = await supabase
        .from('profiles')
        .update({ avatar_url: null })
        .eq('id', userId)
        .select('id, display_name, avatar_url, created_at, updated_at')
        .single();
      check({ error });
      return data;
    },

    async getAvatarUrl(path) {
      if (!path) return null;
      try {
        const { data, error } = await supabase.storage
          .from('avatars')
          .createSignedUrl(path, 3600); // 1 hour TTL
        if (error || !data?.signedUrl) return null;
        return data.signedUrl;
      } catch {
        return null;
      }
    },
  };
}
