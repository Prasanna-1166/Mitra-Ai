import { looksSensitive, sanitizeMemoryText } from '../../supabase/functions/_shared/memory.js';

const check = ({ error }) => {
  if (error) {
    const e = new Error(error.message || 'Database error');
    e.code = error.code;
    throw e;
  }
};

export class MemoryRejectedError extends Error {}

// Returns the cleaned text, or throws when it is empty or looks like a credential.
export function prepareMemoryText(text) {
  const clean = sanitizeMemoryText(text);
  if (clean.length < 3) throw new MemoryRejectedError('Write a short note of at least a few characters.');
  if (looksSensitive(clean)) {
    throw new MemoryRejectedError(
      "That looks like a password, key or personal identifier. Mitra AI won't save it to memory.",
    );
  }
  return clean;
}

export function createMemoryStore(supabase, userId) {
  return {
    async list() {
      const { data, error } = await supabase
        .from('user_memories')
        .select('id, content, category, source, enabled, created_at, updated_at')
        .order('created_at', { ascending: false });
      check({ error });
      return data ?? [];
    },
    async create({ content, category = 'other', source = 'user' }) {
      const clean = prepareMemoryText(content);
      const { data, error } = await supabase
        .from('user_memories')
        .insert({ user_id: userId, content: clean, category, source })
        .select('id, content, category, source, enabled, created_at, updated_at')
        .single();
      check({ error });
      return data;
    },
    async update(id, patch) {
      const next = {};
      if (patch.content !== undefined) next.content = prepareMemoryText(patch.content);
      if (patch.category !== undefined) next.category = patch.category;
      if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
      const { error } = await supabase.from('user_memories').update(next).eq('id', id);
      check({ error });
    },
    async remove(id) {
      const { error } = await supabase.from('user_memories').delete().eq('id', id);
      check({ error });
    },
    async clearAll() {
      const { error } = await supabase.from('user_memories').delete().eq('user_id', userId);
      check({ error });
    },
  };
}

export const DEFAULT_SETTINGS = { response_depth: 'balanced', memory_enabled: true, auto_memory: true };

export function createSettingsStore(supabase, userId) {
  return {
    async get() {
      const { data, error } = await supabase
        .from('user_settings').select('response_depth, memory_enabled, auto_memory').maybeSingle();
      check({ error });
      return { ...DEFAULT_SETTINGS, ...(data ?? {}) };
    },
    // Update first; create the row when none exists yet.
    async save(patch) {
      const { data, error } = await supabase
        .from('user_settings').update(patch).eq('user_id', userId).select('user_id');
      check({ error });
      if ((data ?? []).length === 0) {
        const { error: insertError } = await supabase.from('user_settings').insert({ user_id: userId, ...patch });
        check({ error: insertError });
      }
    },
  };
}
