// Data access for the relay, using the service-role client. Every query is
// explicitly scoped to the authenticated user id established by the ticket;
// nothing here trusts identifiers from the browser for ownership.
// deno-lint-ignore-file no-explicit-any

export function createRepo(admin: any) {
  const check = ({ error }: { error: any }) => {
    if (error) throw new Error(error.message ?? 'database error');
  };

  return {
    async rateLimit(subject: string, windowSeconds: number, max: number) {
      const { data, error } = await admin.rpc('rate_limit_hit', {
        p_subject: subject, p_window_seconds: windowSeconds, p_max: max,
      });
      check({ error });
      return data === true;
    },

    async getConversation(userId: string, conversationId: string) {
      const { data, error } = await admin
        .from('conversations').select('id').eq('id', conversationId).eq('user_id', userId).maybeSingle();
      check({ error });
      return data;
    },

    async reserveUsage({ requestId, userId, guestSessionId, limit }: any) {
      const { data, error } = await admin.rpc('reserve_usage', {
        p_request_id: requestId, p_user_id: userId, p_guest_session_id: guestSessionId, p_limit: limit,
      });
      check({ error });
      return data;
    },

    async finalizeUsage(requestId: string, status: string) {
      const { error } = await admin.rpc('finalize_usage', { p_request_id: requestId, p_status: status });
      check({ error });
    },

    async getUsage({ userId, guestSessionId, limit }: any) {
      const { data, error } = await admin.rpc('get_usage', {
        p_user_id: userId, p_guest_session_id: guestSessionId, p_limit: limit,
      });
      check({ error });
      return data;
    },

    // Newest `limit` messages of one of the user's conversations, oldest first.
    async loadContext(userId: string, conversationId: string, limit: number) {
      const { data, error } = await admin
        .from('messages').select('role, content, status')
        .eq('conversation_id', conversationId).eq('user_id', userId)
        .order('seq', { ascending: false }).limit(limit);
      check({ error });
      return (data ?? []).reverse();
    },

    // Response depth and ENABLED memories. Returns no memories when the user
    // switched memory off.
    async loadPreferences(userId: string) {
      const { data: settings, error } = await admin
        .from('user_settings').select('response_depth, memory_enabled').eq('user_id', userId).maybeSingle();
      check({ error });
      const depth = settings?.response_depth ?? 'balanced';
      if (settings && settings.memory_enabled === false) return { depth, memories: [] };
      const { data: memories, error: memError } = await admin
        .from('user_memories').select('content, category, enabled')
        .eq('user_id', userId).eq('enabled', true).order('created_at', { ascending: false }).limit(200);
      check({ error: memError });
      return { depth, memories: memories ?? [] };
    },

    async saveUserMessage({ userId, conversationId, messageId, content }: any) {
      const { error } = await admin.from('messages').upsert(
        { conversation_id: conversationId, user_id: userId, client_id: messageId, role: 'user', content, status: 'complete' },
        { onConflict: 'conversation_id,client_id', ignoreDuplicates: true },
      );
      check({ error });
    },

    async saveAssistantMessage({ userId, conversationId, messageId, content, status, error: errorText }: any) {
      const { error } = await admin.from('messages').upsert(
        { conversation_id: conversationId, user_id: userId, client_id: messageId, role: 'assistant',
          content, status, error: errorText ?? null },
        { onConflict: 'conversation_id,client_id', ignoreDuplicates: true },
      );
      check({ error });
    },
  };
}
