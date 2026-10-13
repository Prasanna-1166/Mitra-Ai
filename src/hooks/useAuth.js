import { useEffect, useMemo, useState } from 'react';
import { isBackendConfigured, supabase } from '../lib/supabaseClient';
import { createAuthService } from '../services/authService';

// Session state comes only from the official Supabase client (it stores and
// refreshes the tokens). `recovery` is true while a password-reset link is open.
export function useAuth() {
  const [state, setState] = useState({ loading: isBackendConfigured, session: null, recovery: false });

  const service = useMemo(
    () =>
      isBackendConfigured
        ? createAuthService(supabase, { redirectTo: `${window.location.origin}${window.location.pathname}` })
        : null,
    [],
  );

  useEffect(() => {
    if (!service) return undefined;
    let cancelled = false;
    service.getSession().then((session) => {
      if (!cancelled) setState((s) => ({ ...s, loading: false, session }));
    });
    const subscription = service.onAuthStateChange((event, session) => {
      setState((s) => ({
        loading: false,
        session,
        recovery: event === 'PASSWORD_RECOVERY' ? true : event === 'SIGNED_OUT' ? false : s.recovery,
      }));
    });
    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, [service]);

  return {
    configured: isBackendConfigured,
    loading: state.loading,
    session: state.session,
    user: state.session?.user ?? null,
    recovery: state.recovery,
    finishRecovery: () => setState((s) => ({ ...s, recovery: false })),
    service,
  };
}
