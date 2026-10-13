// Cloud conversations. Ownership is enforced by row-level security in the
// database; the user id passed here is only used to fill the owner column and is
// verified by the policies, never trusted on its own.
import { isUuid } from '../../supabase/functions/_shared/protocol.js';

const PAGE = 50;
const IMPORT_BATCH = 100;

const mapMessage = (row) => ({
  id: row.client_id ?? row.id,
  seq: row.seq,
  role: row.role,
  content: row.content,
  timestamp: row.created_at,
  ...(row.role === 'assistant' ? { status: row.status, ...(row.error ? { error: row.error } : {}) } : {}),
});

const mapConversation = (row) => ({
  id: row.id,
  title: row.title,
  titleSource: row.title_source,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const check = ({ error }) => {
  if (error) {
    const e = new Error(error.message || 'Database error');
    e.code = error.code;
    throw e;
  }
};

export function createCloudStore(supabase, userId) {
  return {
    async listConversations({ before, limit = PAGE } = {}) {
      let q = supabase
        .from('conversations')
        .select('id, title, title_source, created_at, updated_at')
        .order('updated_at', { ascending: false })
        .limit(limit + 1);
      if (before) q = q.lt('updated_at', before);
      const { data, error } = await q;
      check({ error });
      const rows = data ?? [];
      return { items: rows.slice(0, limit).map(mapConversation), hasMore: rows.length > limit };
    },

    // Newest page first from the database, returned oldest-first for display.
    async loadMessages(conversationId, { beforeSeq, limit = PAGE } = {}) {
      let q = supabase
        .from('messages')
        .select('id, seq, client_id, role, content, status, error, created_at')
        .eq('conversation_id', conversationId)
        .order('seq', { ascending: false })
        .limit(limit + 1);
      if (beforeSeq) q = q.lt('seq', beforeSeq);
      const { data, error } = await q;
      check({ error });
      const rows = data ?? [];
      return { messages: rows.slice(0, limit).reverse().map(mapMessage), hasMore: rows.length > limit };
    },

    async loadAllMessages(conversationId) {
      const all = [];
      let beforeSeq;
      for (;;) {
        const page = await this.loadMessages(conversationId, { beforeSeq, limit: 200 });
        all.unshift(...page.messages);
        if (!page.hasMore || page.messages.length === 0) return all;
        beforeSeq = page.messages[0].seq;
      }
    },

    async createConversation({ id, title, titleSource, createdAt }) {
      const { error } = await supabase.from('conversations').insert({
        id,
        user_id: userId,
        title,
        title_source: titleSource,
        ...(createdAt ? { created_at: createdAt } : {}),
      });
      if (error && error.code !== '23505') check({ error }); // already created by an earlier attempt
    },

    async renameConversation(id, title, titleSource = 'user') {
      const { error } = await supabase.from('conversations').update({ title, title_source: titleSource }).eq('id', id);
      check({ error });
    },

    async deleteConversation(id) {
      const { error } = await supabase.from('conversations').delete().eq('id', id);
      check({ error });
    },

    async clearMessages(conversationId) {
      const { error } = await supabase.from('messages').delete().eq('conversation_id', conversationId);
      check({ error });
    },

    async deleteMessage(conversationId, messageId) {
      const { error } = await supabase
        .from('messages').delete().eq('conversation_id', conversationId).eq('client_id', messageId);
      check({ error });
    },

    async deleteAllConversations() {
      const { error } = await supabase.from('conversations').delete().eq('user_id', userId);
      check({ error });
    },

    async search(query) {
      const { data, error } = await supabase.rpc('search_conversations', { p_query: query, p_limit: 50 });
      check({ error });
      return new Set(data ?? []);
    },

    // Idempotent: the conversation is keyed by (user, import_key) and each message
    // by (conversation, client_id), so repeating an import never duplicates anything.
    async importConversation(local, { onProgress } = {}) {
      const importKey = String(local.id).slice(0, 100);
      {
        const { error } = await supabase.from('conversations').upsert(
          {
            user_id: userId,
            import_key: importKey,
            title: local.title,
            title_source: local.titleSource === 'user' ? 'user' : local.titleSource === 'auto' ? 'auto' : 'default',
            created_at: local.createdAt,
          },
          { onConflict: 'user_id,import_key', ignoreDuplicates: true },
        );
        check({ error });
      }
      const { data, error } = await supabase.from('conversations').select('id').eq('import_key', importKey).single();
      check({ error });
      const conversationId = data.id;

      const rows = local.messages
        .filter((m) => isUuid(m.id) && typeof m.content === 'string')
        .map((m) => ({
          conversation_id: conversationId,
          user_id: userId,
          client_id: m.id,
          role: m.role,
          content: m.content.slice(0, 60000),
          status: m.role === 'assistant' ? (['complete', 'error', 'stopped'].includes(m.status) ? m.status : 'complete') : 'complete',
          error: m.role === 'assistant' && m.status === 'error' ? (m.error ?? null) : null,
          created_at: m.timestamp,
        }));
      for (let i = 0; i < rows.length; i += IMPORT_BATCH) {
        const { error: batchError } = await supabase
          .from('messages')
          .upsert(rows.slice(i, i + IMPORT_BATCH), { onConflict: 'conversation_id,client_id', ignoreDuplicates: true });
        check({ error: batchError });
        onProgress?.(Math.min(i + IMPORT_BATCH, rows.length), rows.length);
      }
      return conversationId;
    },
  };
}

// Import all guest conversations. Returns the ids that were imported; any failure
// stops the run and leaves the guest copies untouched so it can be retried.
export async function importGuestHistory(cloud, sessions, { onProgress } = {}) {
  const ordered = [...sessions].sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
  const imported = [];
  for (let i = 0; i < ordered.length; i += 1) {
    await cloud.importConversation(ordered[i]);
    imported.push(ordered[i].id);
    onProgress?.(i + 1, ordered.length);
  }
  return imported;
}
