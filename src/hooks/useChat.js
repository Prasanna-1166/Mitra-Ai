import { useEffect, useState, useSyncExternalStore } from 'react';
import { config } from '../config';
import { ChatController } from '../lib/chatController';
import { LOCAL_ERRORS, startRelayRequest } from '../lib/relayClient';
import { functionUrl, isBackendConfigured, relayUrl, supabase, supabasePublishableKey } from '../lib/supabaseClient';
import { createCloudStore } from '../services/conversationService';
import { createTicketClient } from '../services/usageService';

function getBrowserStorage() {
  try {
    const storage = window.localStorage;
    storage.setItem('mitra-ai:probe', '1');
    storage.removeItem('mitra-ai:probe');
    return storage;
  } catch {
    return null; // blocked: guest history stays in memory only
  }
}

function buildController() {
  const storage = getBrowserStorage();
  const ticketClient = isBackendConfigured
    ? createTicketClient({
        ticketUrl: functionUrl('chat-ticket'),
        publishableKey: supabasePublishableKey,
        // getSession() refreshes an expired access token before returning it.
        getAccessToken: async () => (await supabase.auth.getSession()).data.session?.access_token ?? null,
        storage,
      })
    : null;
  const notConfigured = () => {
    const err = new Error('not configured');
    err.code = LOCAL_ERRORS.NOT_CONFIGURED;
    throw err;
  };
  return new ChatController({
    storage,
    createCloud: (userId) => createCloudStore(supabase, userId),
    startRequest: (opts) =>
      startRelayRequest({
        ...opts,
        getTicket: ticketClient ? ticketClient.getTicket : notConfigured,
        relayUrl: isBackendConfigured ? relayUrl() : 'wss://not-configured.invalid',
        connectTimeoutMs: config.connectTimeoutMs,
        idleTimeoutMs: config.idleTimeoutMs,
      }),
    fetchUsage: ticketClient ? ticketClient.status : async () => null,
    config: { maxMessageChars: config.maxMessageChars, contextMessages: config.contextMessages },
  });
}

// authLoading: wait for the stored session to be restored before choosing
// between guest and signed-in mode (so a refresh never flashes guest data).
export function useChat({ userId, authLoading, onAuthProblem }) {
  const [controller] = useState(buildController);
  const state = useSyncExternalStore(controller.subscribe, controller.getState);

  useEffect(() => {
    controller.setAuthProblemHandler(onAuthProblem);
  }, [controller, onAuthProblem]);

  useEffect(() => {
    if (!authLoading) controller.setIdentity(userId ?? null);
  }, [controller, authLoading, userId]);

  useEffect(() => {
    const save = () => controller.flush();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') save();
    };
    window.addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', save);
      document.removeEventListener('visibilitychange', onVisibility);
      controller.stop();
    };
  }, [controller]);

  return { state, controller };
}
