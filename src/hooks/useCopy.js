import { useCallback, useEffect, useRef, useState } from 'react';
import { copyText } from '../lib/clipboard';

// status: 'idle' | 'copied' | 'failed' (resets automatically)
export function useCopy(resetMs = 2000) {
  const [status, setStatus] = useState('idle');
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = useCallback(
    async (text) => {
      const ok = await copyText(text);
      setStatus(ok ? 'copied' : 'failed');
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setStatus('idle'), resetMs);
      return ok;
    },
    [resetMs],
  );

  return { status, copy };
}
