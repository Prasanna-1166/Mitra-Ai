import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import {
  extractExplicitMemory,
  guessCategory,
  suggestMemory,
} from '../../supabase/functions/_shared/memory.js';
import { DEFAULT_SETTINGS, MemoryRejectedError, createMemoryStore, createSettingsStore } from '../services/memoryService';

const DEPTH_KEY = 'mitra-ai:depth';
const DEPTHS = ['concise', 'balanced', 'detailed'];

function readGuestDepth() {
  try {
    const v = localStorage.getItem(DEPTH_KEY);
    if (DEPTHS.includes(v)) return v;
  } catch {
    /* storage blocked */
  }
  return 'balanced';
}

// Response depth, memory settings and memories for the current account. Results
// are tagged with the owner id, so data loaded for a previous account can never
// be shown after switching (derived below instead of reset in an effect).
export function useAccountData({ userId, controller }) {
  const [guestDepth, setGuestDepth] = useState(readGuestDepth);
  const [loaded, setLoaded] = useState({ ownerId: null, settings: DEFAULT_SETTINGS, memories: [], error: null });
  const [suggestion, setSuggestion] = useState(null); // { text, category }
  const [memoryNotice, setMemoryNotice] = useState(null); // { kind: 'saved' | 'info' | 'error', text }

  const stores = useMemo(
    () => (userId ? { memory: createMemoryStore(supabase, userId), settings: createSettingsStore(supabase, userId) } : null),
    [userId],
  );

  useEffect(() => {
    if (!stores) return undefined;
    let cancelled = false;
    Promise.all([stores.settings.get(), stores.memory.list()])
      .then(([settings, memories]) => {
        if (!cancelled) setLoaded({ ownerId: userId, settings, memories, error: null });
      })
      .catch(() => {
        if (!cancelled) setLoaded({ ownerId: userId, settings: DEFAULT_SETTINGS, memories: [], error: "Couldn't load your settings and memory." });
      });
    return () => {
      cancelled = true;
    };
  }, [stores, userId]);

  const current = userId && loaded.ownerId === userId ? loaded : { settings: DEFAULT_SETTINGS, memories: [], error: null };
  const depth = userId ? current.settings.response_depth : guestDepth;

  useEffect(() => {
    controller.setDepth(depth);
  }, [controller, depth]);

  const patchSettings = useCallback(
    async (patch) => {
      const previous = current.settings;
      setLoaded((l) => ({ ...l, ownerId: userId, settings: { ...l.settings, ...patch }, memories: l.ownerId === userId ? l.memories : [] }));
      try {
        await stores.settings.save(patch);
      } catch {
        setLoaded((l) => ({ ...l, settings: previous, error: "That setting couldn't be saved." }));
      }
    },
    [stores, userId, current.settings],
  );

  const setDepth = useCallback(
    (value) => {
      if (!DEPTHS.includes(value)) return;
      if (userId) patchSettings({ response_depth: value });
      else {
        setGuestDepth(value);
        try {
          localStorage.setItem(DEPTH_KEY, value);
        } catch {
          /* storage blocked */
        }
      }
    },
    [userId, patchSettings],
  );

  const mutateMemories = (fn) => setLoaded((l) => ({ ...l, memories: fn(l.memories), error: null }));

  const addMemory = useCallback(
    async (content, { category = 'other', source = 'user' } = {}) => {
      const created = await stores.memory.create({ content, category, source });
      mutateMemories((list) => [created, ...list]);
      return created;
    },
    [stores],
  );
  const updateMemory = useCallback(
    async (id, patch) => {
      await stores.memory.update(id, patch);
      mutateMemories((list) => list.map((m) => (m.id === id ? { ...m, ...patch } : m)));
    },
    [stores],
  );
  const removeMemory = useCallback(
    async (id) => {
      await stores.memory.remove(id);
      mutateMemories((list) => list.filter((m) => m.id !== id));
    },
    [stores],
  );
  const clearMemories = useCallback(async () => {
    await stores.memory.clearAll();
    mutateMemories(() => []);
  }, [stores]);

  // Called with every message the user successfully submits.
  const handleUserMessage = useCallback(
    async (text) => {
      const explicit = extractExplicitMemory(text);
      if (!userId) {
        if (explicit) setMemoryNotice({ kind: 'info', text: 'Memory is available with an account. Sign in to save notes for future chats.' });
        return;
      }
      const { memory_enabled: memoryOn, auto_memory: autoOn } = current.settings;
      if (explicit) {
        if (!memoryOn) {
          setMemoryNotice({ kind: 'info', text: 'Memory is turned off. You can turn it on in Settings.' });
          return;
        }
        try {
          const created = await addMemory(explicit, { category: guessCategory(explicit), source: 'explicit' });
          setMemoryNotice({ kind: 'saved', text: created.content, id: created.id });
        } catch (err) {
          setMemoryNotice({ kind: 'error', text: err instanceof MemoryRejectedError ? err.message : "That couldn't be saved to memory." });
        }
        return;
      }
      if (memoryOn && autoOn) {
        const candidate = suggestMemory(text);
        if (candidate && !current.memories.some((m) => m.content.toLowerCase() === candidate.toLowerCase())) {
          setSuggestion({ text: candidate, category: guessCategory(candidate) });
        }
      }
    },
    [userId, current.settings, current.memories, addMemory],
  );

  const acceptSuggestion = useCallback(async () => {
    if (!suggestion || !stores) return;
    try {
      const created = await addMemory(suggestion.text, { category: suggestion.category, source: 'suggested' });
      setMemoryNotice({ kind: 'saved', text: created.content, id: created.id });
    } catch (err) {
      setMemoryNotice({ kind: 'error', text: err instanceof MemoryRejectedError ? err.message : "That couldn't be saved to memory." });
    }
    setSuggestion(null);
  }, [suggestion, stores, addMemory]);

  return {
    depth,
    setDepth,
    settings: current.settings,
    memories: current.memories,
    error: current.error,
    setMemoryEnabled: (v) => patchSettings({ memory_enabled: v }),
    setAutoMemory: (v) => patchSettings({ auto_memory: v }),
    addMemory,
    updateMemory,
    removeMemory,
    clearMemories,
    handleUserMessage,
    suggestion,
    dismissSuggestion: () => setSuggestion(null),
    acceptSuggestion,
    memoryNotice,
    dismissMemoryNotice: () => setMemoryNotice(null),
    undoSavedMemory: async (id) => {
      try {
        await removeMemory(id);
      } finally {
        setMemoryNotice(null);
      }
    },
  };
}
