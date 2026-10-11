import { useSyncExternalStore } from 'react';

export function useMediaQuery(query) {
  const subscribe = (notify) => {
    const mql = window.matchMedia(query);
    mql.addEventListener('change', notify);
    return () => mql.removeEventListener('change', notify);
  };
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => true,
  );
}
