import { useEffect, useState, useSyncExternalStore } from 'react';
import { processAvatar } from '../lib/image';
import { ProfileManager } from '../lib/profileManager';
import { supabase } from '../lib/supabaseClient';
import { createProfileStore } from '../services/profileService';

// Profile of the signed-in user. Changing the user id clears the previous
// account's profile and avatar immediately.
export function useProfile(userId) {
  const [manager] = useState(
    () => new ProfileManager({ createStore: (id) => createProfileStore(supabase, id), processImage: processAvatar }),
  );
  const state = useSyncExternalStore(manager.subscribe, manager.getState);

  useEffect(() => {
    manager.setUser(userId ?? null);
  }, [manager, userId]);

  return { state, manager };
}
