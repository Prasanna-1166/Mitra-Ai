import { useCallback, useEffect, useMemo, useState } from 'react';
import { createProfileStore } from '../services/profileService';

export function useProfile({ user, supabaseClient }) {
  const userId = user?.id ?? null;
  const userEmail = user?.email ?? null;

  const [state, setState] = useState({
    profile: null,
    avatarUrl: null,
    loading: Boolean(userId),
    error: null,
    ownerId: null,
  });

  const store = useMemo(
    () => (userId && supabaseClient ? createProfileStore(supabaseClient, userId) : null),
    [userId, supabaseClient],
  );

  const load = useCallback(async () => {
    if (!store || !userId) {
      setState({ profile: null, avatarUrl: null, loading: false, error: null, ownerId: null });
      return;
    }

    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const profile = await store.getProfile(userEmail);
      let avatarUrl = null;
      if (profile?.avatar_url) {
        avatarUrl = await store.getAvatarUrl(profile.avatar_url);
      }
      setState({ profile, avatarUrl, loading: false, error: null, ownerId: userId });
    } catch {
      setState((s) => ({
        ...s,
        loading: false,
        error: "Couldn't load your profile information.",
        ownerId: userId,
      }));
    }
  }, [store, userId, userEmail]);

  useEffect(() => {
    if (!userId || !store) return undefined;
    let cancelled = false;

    store
      .getProfile(userEmail)
      .then(async (profile) => {
        if (cancelled) return;
        let avatarUrl = null;
        if (profile?.avatar_url) {
          avatarUrl = await store.getAvatarUrl(profile.avatar_url);
        }
        if (!cancelled) {
          setState({ profile, avatarUrl, loading: false, error: null, ownerId: userId });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState({
            profile: null,
            avatarUrl: null,
            loading: false,
            error: "Couldn't load your profile.",
            ownerId: userId,
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [store, userId, userEmail]);

  // Ensure stale profile from previous account is never shown
  const activeProfile = userId && state.ownerId === userId ? state.profile : null;
  const activeAvatarUrl = userId && state.ownerId === userId ? state.avatarUrl : null;

  const updateDisplayName = useCallback(
    async (displayName) => {
      if (!store) throw new Error('Not signed in');
      const updated = await store.updateDisplayName(displayName);
      setState((s) => ({ ...s, profile: updated, error: null }));
      return updated;
    },
    [store],
  );

  const uploadAvatar = useCallback(
    async (file) => {
      if (!store) throw new Error('Not signed in');
      const currentPath = activeProfile?.avatar_url ?? null;
      const { profile: updated, signedUrl } = await store.uploadAvatar(file, currentPath);
      setState((s) => ({ ...s, profile: updated, avatarUrl: signedUrl, error: null }));
      return { profile: updated, signedUrl };
    },
    [store, activeProfile],
  );

  const removeAvatar = useCallback(async () => {
    if (!store) throw new Error('Not signed in');
    const currentPath = activeProfile?.avatar_url ?? null;
    const updated = await store.removeAvatar(currentPath);
    setState((s) => ({ ...s, profile: updated, avatarUrl: null, error: null }));
    return updated;
  }, [store, activeProfile]);

  return {
    profile: activeProfile,
    avatarUrl: activeAvatarUrl,
    loading: state.loading,
    error: state.error,
    updateDisplayName,
    uploadAvatar,
    removeAvatar,
    refresh: load,
  };
}
