// Framework-free chat store: sessions, the single active request, persistence.
// React reads it through useSyncExternalStore (see hooks/useChat.js).
//
// Policy: there is at most ONE active generation. Switching chat, starting a
// new chat, clearing, or deleting the active chat cancels it first (partial
// text is kept and marked "stopped"). Each request has a unique id and its own
// socket, and every callback re-checks that it still belongs to the active
// request, so a late event from an old socket can never touch newer state.

import { startChatRequest } from './chatClient.js';
import {
  DEFAULT_TITLE,
  createSession,
  deriveTitle,
  hasUserMessages,
  sanitizeTitle,
} from './chatState.js';
import { makeId } from './ids.js';
import { LIMITS, clearHistory, loadHistory, saveHistory } from './storage.js';

const FLUSH_MS = 50; // batch streamed chunks into ~20 renders per second
const SAVE_MS = 600; // throttle localStorage writes while streaming

const defaultTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
};

export class ChatController {
  constructor({
    storage = null,
    WebSocketImpl,
    config,
    timers = defaultTimers,
    uuid = makeId,
    now = () => new Date().toISOString(),
  }) {
    this.storage = storage;
    this.WebSocketImpl = WebSocketImpl;
    this.config = config;
    this.timers = timers;
    this.uuid = uuid;
    this.now = now;

    this.listeners = new Set();
    this.active = null; // { requestId, handle, streaming }
    this.buffer = '';
    this.flushTimer = null;
    this.saveTimer = null;
    this.dirty = false;
    this.saveFailed = false;
    this.dismissedWarning = null;

    // Reading is side-effect free, so React StrictMode may construct this twice.
    const loaded = loadHistory(storage);
    this.state = {
      sessions: loaded.sessions,
      activeSessionId: loaded.activeSessionId,
      request: null, // { requestId, sessionId, kind, messageId, phase }
      outcome: null, // 'complete' | 'stopped' | 'error' (for screen-reader announcements)
      welcomeErrors: {}, // sessionId -> text (greeting failed before any text arrived)
      storageWarning: loaded.warning,
    };
  }

  // ---- store plumbing ----------------------------------------------------
  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = () => this.state;

  setState(patch, { persist = false } = {}) {
    this.state = { ...this.state, ...patch };
    if (persist) this.persist(persist === 'now');
    this.listeners.forEach((l) => l());
  }

  mapSession(id, fn) {
    return this.state.sessions.map((s) => (s.id === id ? fn(s) : s));
  }

  // ---- lifecycle ---------------------------------------------------------
  // Safe to call repeatedly (StrictMode runs effects twice in development).
  start() {
    const { sessions, activeSessionId, request } = this.state;
    if (sessions.length === 0) {
      this.createChat();
      return;
    }
    const active = sessions.find((s) => s.id === activeSessionId);
    if (active?.awaitingWelcome && active.messages.length === 0 && !request) {
      this.beginRequest({ sessionId: active.id, kind: 'welcome' });
    }
  }

  // Called on unmount: cancel network work and write pending changes.
  stop() {
    this.cancelActive('dispose');
    this.flush();
  }

  // ---- persistence -------------------------------------------------------
  persist(immediate = false) {
    this.dirty = true;
    if (immediate) {
      this.flush();
    } else if (this.saveTimer === null) {
      this.saveTimer = this.timers.setTimeout(() => {
        this.saveTimer = null;
        this.flush();
      }, SAVE_MS);
    }
  }

  flush() {
    if (this.saveTimer !== null) {
      this.timers.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    const result = saveHistory(this.storage, {
      sessions: this.state.sessions,
      activeSessionId: this.state.activeSessionId,
    });
    // A failed save sets the warning; a later successful save clears only that
    // warning (not a "history was unreadable" notice from start-up).
    const warning = result.ok
      ? this.saveFailed
        ? null
        : this.state.storageWarning
      : result.warning;
    this.saveFailed = !result.ok;
    const shown = warning && warning === this.dismissedWarning ? null : warning;
    if (shown !== this.state.storageWarning) {
      this.state = { ...this.state, storageWarning: shown };
      this.listeners.forEach((l) => l());
    }
  }

  dismissStorageWarning = () => {
    this.dismissedWarning = this.state.storageWarning; // don't nag on every save
    if (this.state.storageWarning) this.setState({ storageWarning: null });
  };

  // ---- chat actions ------------------------------------------------------
  createChat({ welcome = true } = {}) {
    this.cancelActive('switch');
    const id = this.uuid();
    const session = {
      ...createSession({ id, chatId: this.uuid(), now: this.now() }),
      awaitingWelcome: welcome, // in-memory only
    };
    // Keep the list bounded in memory as well as in storage.
    const kept = [session, ...this.state.sessions].slice(0, LIMITS.maxSessions);
    this.setState({ sessions: kept, activeSessionId: id, outcome: null }, { persist: 'now' });
    if (welcome) this.beginRequest({ sessionId: id, kind: 'welcome' });
    return id;
  }

  // "New chat" does nothing when the current chat is still untouched.
  newChat = () => {
    const active = this.activeSession();
    if (active && !hasUserMessages(active) && active.messages.length <= 1) return false;
    this.createChat();
    return true;
  };

  switchSession = (id) => {
    if (id === this.state.activeSessionId) return;
    if (!this.state.sessions.some((s) => s.id === id)) return;
    this.cancelActive('switch');
    this.setState({ activeSessionId: id, outcome: null }, { persist: true });
  };

  deleteSession = (id) => {
    if (!this.state.sessions.some((s) => s.id === id)) return;
    if (this.state.request?.sessionId === id) this.cancelActive('delete');
    const remaining = this.state.sessions.filter((s) => s.id !== id);
    const welcomeErrors = { ...this.state.welcomeErrors };
    delete welcomeErrors[id];
    if (remaining.length === 0) {
      this.setState({ sessions: [], activeSessionId: null, welcomeErrors }, { persist: 'now' });
      this.createChat();
      return;
    }
    const activeSessionId =
      this.state.activeSessionId === id ? remaining[0].id : this.state.activeSessionId;
    this.setState({ sessions: remaining, activeSessionId, welcomeErrors }, { persist: 'now' });
  };

  // Empties the active conversation. It gets a fresh provider chatId so the
  // provider's server-side memory of the old messages is not carried over.
  clearSession = () => {
    const active = this.activeSession();
    if (!active) return;
    this.cancelActive('switch');
    const welcomeErrors = { ...this.state.welcomeErrors };
    delete welcomeErrors[active.id];
    const sessions = this.mapSession(active.id, (s) => ({
      ...s,
      chatId: this.uuid(),
      messages: [],
      title: s.titleSource === 'user' ? s.title : DEFAULT_TITLE,
      titleSource: s.titleSource === 'user' ? 'user' : 'default',
      updatedAt: this.now(),
      awaitingWelcome: true,
    }));
    this.setState({ sessions, welcomeErrors, outcome: null }, { persist: 'now' });
    this.beginRequest({ sessionId: active.id, kind: 'welcome' });
  };

  deleteAll = () => {
    this.cancelActive('delete');
    this.setState({ sessions: [], activeSessionId: null, welcomeErrors: {}, outcome: null });
    clearHistory(this.storage);
    this.dirty = false;
    this.createChat();
  };

  renameSession = (id, rawTitle) => {
    const title = sanitizeTitle(rawTitle);
    if (!title || !this.state.sessions.some((s) => s.id === id)) return false;
    this.setState(
      { sessions: this.mapSession(id, (s) => ({ ...s, title, titleSource: 'user' })) },
      { persist: 'now' },
    );
    return true;
  };

  sendMessage = (rawText) => {
    const text = typeof rawText === 'string' ? rawText.trim() : '';
    if (!text || this.state.request) return false; // empty, or a generation is running
    let session = this.activeSession();
    if (!session) {
      this.createChat({ welcome: false });
      session = this.activeSession();
    }
    const timestamp = this.now();
    const userMessage = { id: this.uuid(), role: 'user', content: text, timestamp };
    const welcomeErrors = { ...this.state.welcomeErrors };
    delete welcomeErrors[session.id];
    const derivedTitle = deriveTitle(text); // null until the text is meaningful
    this.setState(
      {
        sessions: this.mapSession(session.id, (s) => {
          const retitle = s.titleSource === 'default' && derivedTitle;
          return {
            ...s,
            awaitingWelcome: false,
            title: retitle ? derivedTitle : s.title,
            titleSource: retitle ? 'auto' : s.titleSource,
            updatedAt: timestamp,
            messages: [...s.messages, userMessage],
          };
        }),
        welcomeErrors,
      },
      { persist: 'now' },
    );
    this.beginRequest({ sessionId: session.id, kind: 'reply', text });
    return true;
  };

  stopGeneration = () => {
    this.cancelActive('user');
  };

  // Retry the last failed reply (or the failed greeting).
  retryMessage = (messageId) => {
    if (this.state.request) return false;
    const session = this.activeSession();
    if (!session) return false;
    const index = session.messages.findIndex((m) => m.id === messageId);
    const message = session.messages[index];
    if (!message || message.role !== 'assistant' || message.status !== 'error') return false;
    if (index !== session.messages.length - 1) return false; // only the latest reply

    if (message.kind === 'welcome') {
      this.setState(
        {
          sessions: this.mapSession(session.id, (s) => ({
            ...s,
            awaitingWelcome: true,
            messages: s.messages.filter((m) => m.id !== messageId),
          })),
        },
        { persist: true },
      );
      this.beginRequest({ sessionId: session.id, kind: 'welcome' });
      return true;
    }
    const prompt = [...session.messages.slice(0, index)].reverse().find((m) => m.role === 'user');
    if (!prompt) return false;
    this.beginRequest({
      sessionId: session.id,
      kind: 'reply',
      text: prompt.content,
      replaceMessageId: messageId,
    });
    return true;
  };

  retryWelcome = () => {
    const session = this.activeSession();
    if (!session || this.state.request || session.messages.length > 0) return false;
    this.beginRequest({ sessionId: session.id, kind: 'welcome' });
    return true;
  };

  activeSession() {
    return this.state.sessions.find((s) => s.id === this.state.activeSessionId) ?? null;
  }

  // ---- request orchestration --------------------------------------------
  beginRequest({ sessionId, kind, text, replaceMessageId }) {
    this.cancelActive('switch'); // defensive: never run two generations
    const session = this.state.sessions.find((s) => s.id === sessionId);
    if (!session) return;

    const requestId = this.uuid();
    const messageId = this.uuid();
    const timestamp = this.now();

    const welcomeErrors = { ...this.state.welcomeErrors };
    delete welcomeErrors[sessionId];

    const sessions = this.mapSession(sessionId, (s) => {
      const base = replaceMessageId
        ? s.messages.filter((m) => m.id !== replaceMessageId)
        : s.messages;
      // Replies get a placeholder bubble straight away; the greeting only
      // appears once its first text arrives.
      const messages =
        kind === 'reply'
          ? [...base, { id: messageId, role: 'assistant', content: '', timestamp, status: 'pending' }]
          : base;
      return { ...s, messages };
    });

    this.setState(
      {
        sessions,
        welcomeErrors,
        outcome: null,
        request: { requestId, sessionId, kind, messageId, phase: 'connecting' },
      },
      { persist: kind === 'reply' ? 'now' : false },
    );

    const entry = { requestId, handle: null, streaming: false };
    this.active = entry;
    const live = () => this.active === entry;

    entry.handle = startChatRequest({
      url: this.config.wsUrl,
      payload: {
        chatId: session.chatId,
        appId: this.config.appId,
        systemPrompt: this.config.systemPrompt,
        message: kind === 'welcome' ? this.config.welcomePrompt : text,
      },
      WebSocketImpl: this.WebSocketImpl,
      connectTimeoutMs: this.config.connectTimeoutMs,
      idleTimeoutMs: this.config.idleTimeoutMs,
      timers: this.timers,
      onOpen: () => {
        if (!live() || entry.streaming) return;
        this.setState({ request: { ...this.state.request, phase: 'generating' } });
      },
      onChunk: (chunk) => {
        if (!live()) return;
        this.buffer += chunk;
        if (!entry.streaming) {
          entry.streaming = true;
          this.applyBuffer(); // show the first text immediately
        } else if (this.flushTimer === null) {
          this.flushTimer = this.timers.setTimeout(() => {
            this.flushTimer = null;
            if (live()) this.applyBuffer();
          }, FLUSH_MS);
        }
      },
      onComplete: () => {
        if (live()) this.settle(entry, { type: 'complete' });
      },
      onError: (error) => {
        if (live()) this.settle(entry, { type: 'error', error });
      },
    });
  }

  // Move buffered text into the message the active request is writing to.
  applyBuffer() {
    if (this.flushTimer !== null) {
      this.timers.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const text = this.buffer;
    this.buffer = '';
    const request = this.state.request;
    if (!text || !request) return;
    const { sessionId, messageId, kind } = request;
    const timestamp = this.now();

    const sessions = this.mapSession(sessionId, (s) => {
      const exists = s.messages.some((m) => m.id === messageId);
      if (!exists) {
        if (kind !== 'welcome') return s;
        return {
          ...s,
          updatedAt: timestamp,
          messages: [
            ...s.messages,
            { id: messageId, role: 'assistant', kind: 'welcome', content: text, timestamp, status: 'streaming' },
          ],
        };
      }
      return {
        ...s,
        updatedAt: timestamp,
        messages: s.messages.map((m) =>
          m.id === messageId ? { ...m, content: m.content + text, status: 'streaming' } : m,
        ),
      };
    });
    this.setState({ sessions, request: { ...request, phase: 'streaming' } }, { persist: true });
  }

  // Record the end of the active request exactly once.
  settle(entry, outcome) {
    if (this.active !== entry) return;
    this.applyBuffer();
    this.active = null;
    const request = this.state.request;
    if (!request) return;
    const { sessionId, messageId, kind } = request;

    let welcomeErrors = this.state.welcomeErrors;
    const sessions = this.mapSession(sessionId, (s) => {
      const exists = s.messages.some((m) => m.id === messageId);
      const next = { ...s };
      if (kind === 'welcome') next.awaitingWelcome = false;
      if (exists) {
        next.messages = s.messages.map((m) => {
          if (m.id !== messageId) return m;
          if (outcome.type === 'complete') return { ...m, status: 'complete' };
          if (outcome.type === 'stopped') return { ...m, status: 'stopped' };
          return {
            ...m,
            status: 'error',
            error: outcome.error.message,
            ...(outcome.error.messageSent ? { messageSent: true } : {}),
          };
        });
      } else if (kind === 'welcome' && outcome.type === 'error') {
        welcomeErrors = { ...welcomeErrors, [sessionId]: outcome.error.message };
      }
      return next;
    });
    this.setState(
      { sessions, welcomeErrors, request: null, outcome: outcome.type },
      { persist: 'now' },
    );
  }

  // reason: 'user' | 'switch' | 'delete' | 'dispose'
  cancelActive(reason) {
    const entry = this.active;
    if (!entry) return;
    entry.handle?.cancel();
    if (reason === 'delete') {
      // The conversation is going away; just drop the request.
      if (this.flushTimer !== null) {
        this.timers.clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      this.buffer = '';
      this.active = null;
      this.setState({ request: null, outcome: null });
      return;
    }
    const wasWelcome = this.state.request?.kind === 'welcome';
    this.settle(entry, { type: 'stopped' });
    // On unmount, keep the "greeting still wanted" flag so a StrictMode
    // remount can ask again instead of leaving the chat without a greeting.
    if (reason === 'dispose' && wasWelcome) {
      const id = this.state.activeSessionId;
      const session = this.state.sessions.find((s) => s.id === id);
      if (session && session.messages.length === 0) {
        this.setState({ sessions: this.mapSession(id, (s) => ({ ...s, awaitingWelcome: true })) });
      }
    }
  }
}
