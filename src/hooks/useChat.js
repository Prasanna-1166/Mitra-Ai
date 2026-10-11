import { useEffect, useState, useSyncExternalStore } from 'react';
import { config } from '../config';
import { ChatController } from '../lib/chatController';

function getBrowserStorage() {
  try {
    const storage = window.localStorage;
    const probe = 'mitra-ai:probe';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    return null; // blocked (e.g. strict privacy settings): history stays in memory
  }
}

export function useChat() {
  // The controller is created once; constructing it has no side effects.
  const [controller] = useState(
    () => new ChatController({ storage: getBrowserStorage(), config }),
  );
  const state = useSyncExternalStore(controller.subscribe, controller.getState);

  useEffect(() => {
    controller.start();
    const save = () => controller.flush();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') save();
    };
    window.addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', save);
      document.removeEventListener('visibilitychange', onVisibility);
      controller.stop(); // closes the socket and writes pending changes
    };
  }, [controller]);

  return { state, controller };
}
