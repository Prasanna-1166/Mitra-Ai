// Framework-free chat store used through useSyncExternalStore (hooks/useChat.js).
//
// Two storage modes, chosen by identity:
//   guest  conversations live in this browser (localStorage); history is sent
//          with each request because the relay has no stored copy.
//   user   conversations live in the database; the relay reads context and memory
//          from there and saves messages itself.
//
// There is at most ONE active generation. Switching chat, starting a new chat,
// clearing, or deleting the active chat cancels it first (partial text is kept
// and marked "stopped"). Each request has its own id and socket and every callback
// re-checks it still owns the active slot, so late events can never leak into a
// newer request. Identity changes bump an `epoch`, so async results that belong
// to a previous account are discarded.

import { DEFAULT_TITLE, deriveTitle, sanitizeTitle } from './chatState.js';
import { makeId } from './ids.js';
import { LIMITS, clearHistory, loadHistory, saveHistory } from './storage.js';

const FLUSH_MS = 50;
const SAVE_MS = 600;

const defaultTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
};

const blankState = () => ({
  kind: null, // 'guest' | 'user' once an identity is set
  userId: null,
  sessions: [],
  activeSessionId: null,
  loadingSessions: false,
  hasMoreSessions: false,
  request: null, // { requestId, sessionId, messageId, phase }
  outcome: null, // 'complete' | 'stopped' | 'error' (screen-reader announcements)
  usage: null, // { used, limit, remaining, resetsAt }
  limits: null, // { guest, user } as configured on the server
  limit: null, // { kind, usage, restoredText } when the allowance is exhausted
  notice: null, // { text } transient error shown to the user
  storageWarning: null,
});

export class ChatController {
  constructor({
    storage = null,
    createCloud = () => null,
    startRequest,
    fetchUsage = async () => null,
    config,
    timers = defaultTimers,
    uuid = makeId,
    now = () => new Date().toISOString(),
    onAuthProblem = () => {},
  }) {
    Object.assign(this, { storage, createCloud, startRequest, fetchUsage, config, timers, uuid, now, onAuthProblem });
    this.listeners = new Set();
    this.state = blankState();
    this.cloud = null;
    this.epoch = 0;
    this.active = null;
    this.buffer = '';
    this.flushTimer = null;
    this.saveTimer = null;
    this.dirty = false;
    this.saveFailed = false;
    this.dismissedWarning = null;
    this.depth = 'balanced';
    this.identity = undefined;
  }

  // ---- store plumbing ----------------------------------------------------
  subscribe = (l) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
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
  activeSession() {
    return this.state.sessions.find((s) => s.id === this.state.activeSessionId) ?? null;
  }
  isGuest() {
    return this.state.kind === 'guest';
  }

  // ---- identity ----------------------------------------------------------
  // userId === null means guest. Safe to call repeatedly with the same value.
  setIdentity = (userId) => {
    const key = userId ?? 'guest';
    if (this.identity === key) return;
    this.flush(); // write the previous guest's pending changes before switching
    this.identity = key;
    this.epoch += 1;
    this.cancelActive('dispose');
    this.dirty = false;
    if (this.saveTimer !== null) {
      this.timers.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    // Drop everything that belonged to the previous identity immediately.
    this.state = blankState();
    const epoch = this.epoch;

    if (!userId) {
      this.cloud = null;
      const loaded = loadHistory(this.storage);
      this.setState({
        kind: 'guest',
        sessions: loaded.sessions.map((s) => ({ ...s, messagesLoaded: true, hasMoreMessages: false, persisted: true })),
        activeSessionId: loaded.activeSessionId,
        storageWarning: loaded.warning,
      });
    } else {
      this.cloud = this.createCloud(userId);
      this.setState({ kind: 'user', userId, loadingSessions: true });
      this.cloud
        .listConversations()
        .then(({ items, hasMore }) => {
          if (epoch !== this.epoch) return;
          this.setState({
            loadingSessions: false,
            hasMoreSessions: hasMore,
            sessions: items.map((c) => ({ ...c, messages: [], messagesLoaded: false, hasMoreMessages: false, persisted: true })),
          });
        })
        .catch(() => {
          if (epoch !== this.epoch) return;
          this.setState({ loadingSessions: false, notice: { text: "Couldn't load your saved chats. Check your connection and reload." } });
        });
    }
    this.refreshUsage();
  };

  // Called on unmount.
  stop() {
    this.cancelActive('dispose');
    this.flush();
  }

  setAuthProblemHandler = (fn) => {
    this.onAuthProblem = fn;
  };

  setDepth = (depth) => {
    this.depth = depth;
  };

  refreshUsage = () => {
    const epoch = this.epoch;
    Promise.resolve(this.fetchUsage())
      .then((res) => {
        if (epoch !== this.epoch || !res?.usage) return;
        this.setState({ usage: res.usage, limits: res.limits ?? this.state.limits });
      })
      .catch((err) => {
        if (epoch === this.epoch && err?.code === 'invalid_session') this.onAuthProblem();
      });
  };

  // ---- guest persistence -------------------------------------------------
  persist(immediate = false) {
    if (!this.isGuest()) return;
    this.dirty = true;
    if (immediate) this.flush();
    else if (this.saveTimer === null) {
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
    if (!this.dirty || !this.isGuest()) return;
    this.dirty = false;
    const result = saveHistory(this.storage, {
      sessions: this.state.sessions,
      activeSessionId: this.state.activeSessionId,
    });
    const warning = result.ok ? (this.saveFailed ? null : this.state.storageWarning) : result.warning;
    this.saveFailed = !result.ok;
    const shown = warning && warning === this.dismissedWarning ? null : warning;
    if (shown !== this.state.storageWarning) this.setState({ storageWarning: shown });
  }

  dismissStorageWarning = () => {
    this.dismissedWarning = this.state.storageWarning;
    if (this.state.storageWarning) this.setState({ storageWarning: null });
  };
  dismissNotice = () => this.setState({ notice: null });
  dismissLimit = () => this.setState({ limit: null });

  fail(text) {
    this.setState({ notice: { text } });
  }

  // ---- chat actions ------------------------------------------------------
  newChat = () => {
    if (this.state.activeSessionId === null) return false;
    this.cancelActive('switch');
    this.setState({ activeSessionId: null, outcome: null }, { persist: true });
    return true;
  };

  switchSession = (id) => {
    if (id === this.state.activeSessionId) return;
    const target = this.state.sessions.find((s) => s.id === id);
    if (!target) return;
    this.cancelActive('switch');
    this.setState({ activeSessionId: id, outcome: null }, { persist: true });
    if (this.cloud && !target.messagesLoaded) this.loadLatestMessages(id);
  };

  loadLatestMessages(id) {
    const epoch = this.epoch;
    this.cloud
      .loadMessages(id)
      .then(({ messages, hasMore }) => {
        if (epoch !== this.epoch) return;
        this.setState({
          sessions: this.mapSession(id, (s) => ({
            ...s,
            messages: s.messagesLoaded ? s.messages : messages,
            messagesLoaded: true,
            hasMoreMessages: hasMore,
          })),
        });
      })
      .catch(() => {
        if (epoch === this.epoch) this.fail("Couldn't load this conversation. Check your connection and try again.");
      });
  }

  loadOlderMessages = () => {
    const session = this.activeSession();
    if (!this.cloud || !session || !session.hasMoreMessages || session.messages.length === 0) return;
    const beforeSeq = session.messages[0].seq;
    if (!beforeSeq) return;
    const epoch = this.epoch;
    this.cloud
      .loadMessages(session.id, { beforeSeq })
      .then(({ messages, hasMore }) => {
        if (epoch !== this.epoch) return;
        this.setState({
          sessions: this.mapSession(session.id, (s) => ({
            ...s,
            messages: [...messages.filter((m) => !s.messages.some((x) => x.id === m.id)), ...s.messages],
            hasMoreMessages: hasMore,
          })),
        });
      })
      .catch(() => {
        if (epoch === this.epoch) this.fail("Couldn't load earlier messages.");
      });
  };

  loadMoreSessions = () => {
    if (!this.cloud || !this.state.hasMoreSessions) return;
    const last = this.state.sessions[this.state.sessions.length - 1];
    const epoch = this.epoch;
    this.cloud
      .listConversations({ before: last?.updatedAt })
      .then(({ items, hasMore }) => {
        if (epoch !== this.epoch) return;
        const known = new Set(this.state.sessions.map((s) => s.id));
        this.setState({
          hasMoreSessions: hasMore,
          sessions: [
            ...this.state.sessions,
            ...items.filter((c) => !known.has(c.id)).map((c) => ({ ...c, messages: [], messagesLoaded: false, hasMoreMessages: false, persisted: true })),
          ],
        });
      })
      .catch(() => {
        if (epoch === this.epoch) this.fail("Couldn't load more chats.");
      });
  };

  reloadFromCloud = () => {
    if (!this.cloud) return;
    const epoch = this.epoch;
    this.cloud
      .listConversations()
      .then(({ items, hasMore }) => {
        if (epoch !== this.epoch) return;
        const open = this.activeSession();
        this.setState({
          hasMoreSessions: hasMore,
          sessions: items.map((c) => {
            const existing = this.state.sessions.find((s) => s.id === c.id);
            return existing ?? { ...c, messages: [], messagesLoaded: false, hasMoreMessages: false, persisted: true };
          }),
          activeSessionId: open && items.some((c) => c.id === open.id) ? open.id : null,
        });
      })
      .catch(() => {});
  };

  searchCloud = (query) => (this.cloud ? this.cloud.search(query) : Promise.resolve(null));

  exportMessages = async (id) => {
    const session = this.state.sessions.find((s) => s.id === id);
    if (!session) return null;
    if (this.cloud && session.hasMoreMessages) {
      return { ...session, messages: await this.cloud.loadAllMessages(id) };
    }
    return session;
  };

  deleteSession = (id) => {
    const session = this.state.sessions.find((s) => s.id === id);
    if (!session) return;
    if (this.state.request?.sessionId === id) this.cancelActive('delete');
    this.setState(
      {
        sessions: this.state.sessions.filter((s) => s.id !== id),
        activeSessionId: this.state.activeSessionId === id ? null : this.state.activeSessionId,
      },
      { persist: 'now' },
    );
    if (this.cloud && session.persisted) {
      const epoch = this.epoch;
      this.cloud.deleteConversation(id).catch(() => {
        if (epoch !== this.epoch) return;
        this.setState({ sessions: [session, ...this.state.sessions] });
        this.fail("The conversation couldn't be deleted. Please try again.");
      });
    }
  };

  clearSession = () => {
    const session = this.activeSession();
    if (!session) return;
    this.cancelActive('switch');
    this.setState(
      {
        sessions: this.mapSession(session.id, (s) => ({
          ...s,
          messages: [],
          hasMoreMessages: false,
          title: s.titleSource === 'user' ? s.title : DEFAULT_TITLE,
          titleSource: s.titleSource === 'user' ? 'user' : 'default',
          updatedAt: this.now(),
        })),
        outcome: null,
      },
      { persist: 'now' },
    );
    if (this.cloud && session.persisted) {
      this.cloud.clearMessages(session.id).catch(() => this.fail("The conversation couldn't be cleared on the server."));
    }
  };

  deleteAll = () => {
    this.cancelActive('delete');
    const before = this.state.sessions;
    this.setState({ sessions: [], activeSessionId: null, outcome: null, hasMoreSessions: false });
    if (this.cloud) {
      const epoch = this.epoch;
      this.cloud.deleteAllConversations().catch(() => {
        if (epoch !== this.epoch) return;
        this.setState({ sessions: before });
        this.fail("Your chats couldn't be deleted. Please try again.");
      });
    } else {
      clearHistory(this.storage);
      this.dirty = false;
    }
  };

  renameSession = (id, rawTitle) => {
    const title = sanitizeTitle(rawTitle);
    const session = this.state.sessions.find((s) => s.id === id);
    if (!title || !session) return false;
    this.setState(
      { sessions: this.mapSession(id, (s) => ({ ...s, title, titleSource: 'user' })) },
      { persist: 'now' },
    );
    if (this.cloud && session.persisted) {
      this.cloud.renameConversation(id, title, 'user').catch(() => this.fail("The new name couldn't be saved."));
    }
    return true;
  };

  sendMessage = (rawText) => {
    const text = typeof rawText === 'string' ? rawText.trim() : '';
    if (!text || text.length > this.config.maxMessageChars) return false; // empty or too long: never reaches the server
    if (this.state.request || !this.state.kind) return false;
    let session = this.activeSession();
    if (session && !session.messagesLoaded) return false; // still loading this conversation

    const timestamp = this.now();
    const derived = deriveTitle(text);
    const userMessage = { id: this.uuid(), role: 'user', content: text, timestamp };

    if (!session) {
      session = {
        id: this.uuid(),
        title: derived ?? DEFAULT_TITLE,
        titleSource: derived ? 'auto' : 'default',
        createdAt: timestamp,
        updatedAt: timestamp,
        messages: [userMessage],
        messagesLoaded: true,
        hasMoreMessages: false,
        persisted: !this.cloud, // guest sessions are "persisted" locally
      };
      const sessions = [session, ...this.state.sessions].slice(0, LIMITS.maxSessions);
      this.setState({ sessions, activeSessionId: session.id, outcome: null, limit: null }, { persist: 'now' });
    } else {
      const retitle = session.titleSource === 'default' && derived;
      this.setState(
        {
          sessions: this.mapSession(session.id, (s) => ({
            ...s,
            title: retitle ? derived : s.title,
            titleSource: retitle ? 'auto' : s.titleSource,
            updatedAt: timestamp,
            messages: [...s.messages, userMessage],
          })),
          outcome: null,
          limit: null,
        },
        { persist: 'now' },
      );
      if (retitle && this.cloud && session.persisted) {
        this.cloud.renameConversation(session.id, derived, 'auto').catch(() => {});
      }
    }
    this.beginRequest({ sessionId: session.id, text, userMessageId: userMessage.id });
    return true;
  };

  stopGeneration = () => this.cancelActive('user');

  // Retry the last failed reply. The user message is not duplicated: it keeps its
  // id, so the relay's idempotent save leaves a single copy.
  retryMessage = (messageId) => {
    if (this.state.request) return false;
    const session = this.activeSession();
    if (!session) return false;
    const index = session.messages.findIndex((m) => m.id === messageId);
    const message = session.messages[index];
    if (!message || message.role !== 'assistant' || message.status !== 'error') return false;
    if (index !== session.messages.length - 1) return false;
    const prompt = [...session.messages.slice(0, index)].reverse().find((m) => m.role === 'user');
    if (!prompt) return false;
    if (this.cloud && session.persisted) {
      this.cloud.deleteMessage(session.id, messageId).catch(() => {}); // the failed attempt is replaced
    }
    this.beginRequest({
      sessionId: session.id,
      text: prompt.content,
      userMessageId: prompt.id,
      replaceMessageId: messageId,
    });
    return true;
  };

  // ---- request orchestration --------------------------------------------
  beginRequest({ sessionId, text, userMessageId, replaceMessageId }) {
    this.cancelActive('switch');
    const session = this.state.sessions.find((s) => s.id === sessionId);
    if (!session) return;

    const requestId = this.uuid();
    const assistantMessageId = this.uuid();
    const timestamp = this.now();

    // Guest context: recent finished messages before this question.
    const before = session.messages.filter((m) => m.id !== userMessageId && m.id !== replaceMessageId);
    const history = before
      .filter((m) => m.role === 'user' || (m.role === 'assistant' && m.status === 'complete'))
      .slice(-this.config.contextMessages)
      .map((m) => ({ role: m.role, content: m.content }));

    this.setState(
      {
        sessions: this.mapSession(sessionId, (s) => ({
          ...s,
          messages: [
            ...s.messages.filter((m) => m.id !== replaceMessageId),
            { id: assistantMessageId, role: 'assistant', content: '', timestamp, status: 'pending' },
          ],
        })),
        outcome: null,
        request: { requestId, sessionId, messageId: assistantMessageId, phase: 'connecting' },
      },
      { persist: 'now' },
    );

    const entry = { requestId, handle: null, streaming: false, text, userMessageId, cancelled: false };
    this.active = entry;
    const live = () => this.active === entry;
    const epoch = this.epoch;

    const payload = {
      requestId,
      userMessageId,
      assistantMessageId,
      message: text,
      depth: this.depth,
      ...(this.cloud ? { conversationId: sessionId } : { history }),
    };

    const run = () => {
      if (!live()) return;
      entry.handle = this.startRequest({
        payload,
        onAccepted: (usage) => {
          if (!live()) return;
          this.setState({
            usage: usage ?? this.state.usage,
            request: { ...this.state.request, phase: 'generating' },
          });
        },
        onChunk: (chunk) => {
          if (!live()) return;
          this.buffer += chunk;
          if (!entry.streaming) {
            entry.streaming = true;
            this.applyBuffer();
          } else if (this.flushTimer === null) {
            this.flushTimer = this.timers.setTimeout(() => {
              this.flushTimer = null;
              if (live()) this.applyBuffer();
            }, FLUSH_MS);
          }
        },
        onComplete: ({ usage } = {}) => {
          if (!live()) return;
          if (usage) this.setState({ usage });
          this.settle(entry, { type: 'complete' });
        },
        onError: (error) => {
          if (!live()) return;
          if (error.usage) this.setState({ usage: error.usage });
          if (error.code === 'quota_exceeded') this.rollbackForQuota(entry, error);
          else {
            if (error.code === 'invalid_session' || error.code === 'session_expired') this.onAuthProblem();
            this.settle(entry, { type: 'error', error });
          }
        },
      });
    };

    // Signed-in chats must exist in the database before the relay can use them.
    if (this.cloud && !session.persisted) {
      this.cloud
        .createConversation({ id: session.id, title: session.title, titleSource: session.titleSource, createdAt: session.createdAt })
        .then(() => {
          if (epoch !== this.epoch) return;
          this.setState({ sessions: this.mapSession(sessionId, (s) => ({ ...s, persisted: true })) });
          run();
        })
        .catch(() => {
          if (!live()) return;
          this.settle(entry, {
            type: 'error',
            error: { message: "Your conversation couldn't be saved, so the question was not sent. Please try again.", messageSent: false },
          });
        });
    } else {
      run();
    }
  }

  applyBuffer() {
    if (this.flushTimer !== null) {
      this.timers.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const text = this.buffer;
    this.buffer = '';
    const request = this.state.request;
    if (!text || !request) return;
    const timestamp = this.now();
    this.setState(
      {
        sessions: this.mapSession(request.sessionId, (s) => ({
          ...s,
          updatedAt: timestamp,
          messages: s.messages.map((m) =>
            m.id === request.messageId ? { ...m, content: m.content + text, status: 'streaming' } : m,
          ),
        })),
        request: { ...request, phase: 'streaming' },
      },
      { persist: true },
    );
  }

  settle(entry, outcome) {
    if (this.active !== entry) return;
    this.applyBuffer();
    this.active = null;
    const request = this.state.request;
    if (!request) return;
    const sessions = this.mapSession(request.sessionId, (s) => ({
      ...s,
      messages: s.messages.map((m) => {
        if (m.id !== request.messageId) return m;
        if (outcome.type === 'complete') return { ...m, status: 'complete' };
        if (outcome.type === 'stopped') return { ...m, status: 'stopped' };
        return {
          ...m,
          status: 'error',
          error: outcome.error.message,
          ...(outcome.error.messageSent ? { messageSent: true } : {}),
        };
      }),
    }));
    this.setState({ sessions, request: null, outcome: outcome.type }, { persist: 'now' });
  }

  // The allowance ran out: undo the optimistic messages, keep everything else,
  // and hand the question back so the user can resend it after signing in.
  rollbackForQuota(entry, error) {
    if (this.active !== entry) return;
    this.clearFlush();
    this.active = null;
    const request = this.state.request;
    if (!request) return;
    const session = this.state.sessions.find((s) => s.id === request.sessionId);
    const remaining = (session?.messages ?? []).filter(
      (m) => m.id !== request.messageId && m.id !== entry.userMessageId,
    );
    let sessions;
    let activeSessionId = this.state.activeSessionId;
    if (remaining.length === 0) {
      sessions = this.state.sessions.filter((s) => s.id !== request.sessionId);
      if (activeSessionId === request.sessionId) activeSessionId = null;
      if (this.cloud && session?.persisted) this.cloud.deleteConversation(request.sessionId).catch(() => {});
    } else {
      sessions = this.mapSession(request.sessionId, (s) => ({ ...s, messages: remaining }));
    }
    this.setState(
      {
        sessions,
        activeSessionId,
        request: null,
        outcome: null,
        limit: { kind: this.state.kind, usage: error.usage ?? this.state.usage, restoredText: entry.text },
      },
      { persist: 'now' },
    );
  }

  clearFlush() {
    if (this.flushTimer !== null) {
      this.timers.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.buffer = '';
  }

  // reason: 'user' | 'switch' | 'delete' | 'dispose'
  cancelActive(reason) {
    const entry = this.active;
    if (!entry) return;
    entry.cancelled = true;
    entry.handle?.cancel();
    if (reason === 'delete') {
      this.clearFlush();
      this.active = null;
      this.setState({ request: null, outcome: null });
      return;
    }
    this.settle(entry, { type: 'stopped' });
  }
}
