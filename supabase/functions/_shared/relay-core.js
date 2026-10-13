// The chat relay's request lifecycle, free of Deno / Supabase specifics so it
// can be tested with fakes. Entry points inject:
//   socket            browser-facing WebSocket (send/close/onmessage/onclose)
//   subject           { userId } or { guestSessionId }  (already authenticated)
//   repo              data access (see supabase/functions/chat-relay/db.ts)
//   UpstreamWebSocket constructor for the AI provider socket
//
// Accounting policy: a reserved prompt is charged only once the provider has
// started answering. A request that fails or is cancelled before any text
// arrived is released ("failed" / "cancelled") and does not use allowance.

import { buildSystemPrompt } from './instructions.js';
import { selectRelevantMemories } from './memory.js';
import { buildUpstreamMessage } from './prompt.js';
import { ERROR_CODES, messageForCode, validateChatRequest } from './protocol.js';

const defaultTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
};

/**
 * @param {object} params
 * @param {any} params.socket
 * @param {any} params.subject
 * @param {any} params.cfg
 * @param {any} params.repo
 * @param {any} params.UpstreamWebSocket
 * @param {any} [params.timers]
 * @param {(event: string, detail?: string) => void} [params.log]
 */
export function handleRelayConnection({
  socket,
  subject,
  cfg,
  repo,
  UpstreamWebSocket,
  timers = defaultTimers,
  log = () => {},
}) {
  const isGuest = !subject.userId;
  const usageArgs = {
    userId: subject.userId ?? null,
    guestSessionId: subject.guestSessionId ?? null,
    limit: isGuest ? cfg.guestPromptLimit : cfg.userDailyLimit,
  };
  const subjectKey = subject.userId ?? `guest:${subject.guestSessionId}`;

  let started = false;
  let clientGone = false;
  let active = null; // { cancel(reason) } for the one request on this connection

  const send = (frame) => {
    if (clientGone) return;
    try {
      socket.send(JSON.stringify(frame));
    } catch {
      /* client socket already closed */
    }
  };
  const closeSocket = () => {
    try {
      socket.close(1000);
    } catch {
      /* already closed */
    }
  };
  const fail = (code, usage, message) => {
    send({
      type: 'error',
      code,
      message: message ?? messageForCode(code),
      usage,
      retryable: code !== ERROR_CODES.QUOTA_EXCEEDED && code !== ERROR_CODES.INVALID_REQUEST,
    });
    closeSocket();
  };

  socket.onmessage = (event) => {
    let frame = null;
    if (typeof event?.data === 'string') {
      try {
        frame = JSON.parse(event.data);
      } catch {
        frame = null;
      }
    }
    if (!frame || typeof frame !== 'object') {
      fail(ERROR_CODES.INVALID_REQUEST);
      return;
    }
    if (frame.type === 'cancel') {
      if (active) active.cancel();
      else closeSocket();
      return;
    }
    if (started) {
      send({ type: 'error', code: ERROR_CODES.INVALID_REQUEST, message: 'One request per connection.', retryable: false });
      return;
    }
    started = true;
    run(frame).catch((err) => {
      log('relay_unhandled', err?.message);
      fail(ERROR_CODES.INTERNAL);
    });
  };
  const onGone = () => {
    clientGone = true;
    if (active) active.cancel();
  };
  socket.onclose = onGone;
  socket.onerror = onGone;

  async function run(raw) {
    const checked = validateChatRequest(raw, { isGuest, cfg });
    if (!checked.ok) return fail(checked.code, undefined, checked.message);
    const req = checked.value;
    const state = { cancelled: false };
    active = { cancel: () => { state.cancelled = true; } };
    let reserved = false;
    let userMessageSaved = false;

    const release = async (status) => {
      if (!reserved) return;
      reserved = false;
      try {
        await repo.finalizeUsage(req.requestId, status);
      } catch (err) {
        log('finalize_failed', err?.message);
      }
    };

    try {
      if (!(await repo.rateLimit(subjectKey, 60, cfg.requestsPerMinute))) {
        return fail(ERROR_CODES.RATE_LIMITED);
      }
      if (!isGuest && !(await repo.getConversation(subject.userId, req.conversationId))) {
        return fail(ERROR_CODES.NOT_FOUND);
      }
      const reservation = await repo.reserveUsage({ requestId: req.requestId, ...usageArgs });
      if (!reservation.allowed) {
        return fail(
          reservation.duplicate ? ERROR_CODES.DUPLICATE : ERROR_CODES.QUOTA_EXCEEDED,
          reservation.usage,
        );
      }
      reserved = true;
      if (state.cancelled) return await release('cancelled');

      // Context and memory come from the database for signed-in users (only
      // data they own); guests supply their own bounded history.
      let history = req.history ?? [];
      let depth = req.depth;
      let memories = [];
      if (!isGuest) {
        history = await repo.loadContext(subject.userId, req.conversationId, cfg.contextMaxMessages * 2);
        const prefs = await repo.loadPreferences(subject.userId);
        depth = prefs.depth;
        memories = selectRelevantMemories(prefs.memories, req.message, {
          maxItems: cfg.memoryMaxItems,
          maxChars: cfg.memoryMaxChars,
        });
        await repo.saveUserMessage({
          userId: subject.userId,
          conversationId: req.conversationId,
          messageId: req.userMessageId,
          content: req.message,
        });
        userMessageSaved = true;
      }
      if (state.cancelled) {
        await persistAssistant({ content: '', status: 'stopped' });
        return await release('cancelled');
      }

      const systemPrompt = buildSystemPrompt({ depth, memories });
      const message = buildUpstreamMessage({
        history,
        message: req.message,
        limits: { maxMessages: cfg.contextMaxMessages, maxChars: cfg.contextMaxChars },
      });

      send({ type: 'accepted', usage: reservation.usage });
      const outcome = cfg.openrouterApiKey
        ? await streamOpenRouter({ systemPrompt, userMessage: req.message, history, state })
        : await streamUpstream({ systemPrompt, message, state });

      const hasText = outcome.text.length > 0;
      let usageStatus = 'failed';
      let assistantStatus = 'error';
      let code = null;
      if (outcome.type === 'complete') {
        usageStatus = 'completed';
        assistantStatus = 'complete';
      } else if (outcome.type === 'cancelled') {
        usageStatus = hasText ? 'partial' : 'cancelled';
        assistantStatus = 'stopped';
      } else {
        usageStatus = hasText ? 'partial' : 'failed';
        code =
          outcome.type === 'empty'
            ? ERROR_CODES.UPSTREAM_EMPTY
            : outcome.type === 'timeout'
              ? ERROR_CODES.UPSTREAM_TIMEOUT
              : ERROR_CODES.UPSTREAM_FAILED;
      }
      await release(usageStatus);
      const saved = await persistAssistant({
        content: outcome.text,
        status: assistantStatus,
        error: code ? messageForCode(code) : undefined,
      });
      let usage;
      try {
        usage = await repo.getUsage(usageArgs);
      } catch {
        usage = undefined;
      }
      if (outcome.type === 'complete') send({ type: 'done', usage, saved });
      else if (outcome.type !== 'cancelled') {
        send({
          type: 'error',
          code,
          message: messageForCode(code),
          usage,
          hasPartial: hasText,
          retryable: true,
        });
      }
      closeSocket();
    } catch (err) {
      log('relay_error', err?.message);
      await release('failed');
      if (userMessageSaved) await persistAssistant({ content: '', status: 'error', error: messageForCode(ERROR_CODES.INTERNAL) });
      fail(ERROR_CODES.INTERNAL);
    } finally {
      active = null;
    }

    async function persistAssistant({ content, status, error }) {
      if (isGuest || !userMessageSaved) return true;
      try {
        await repo.saveAssistantMessage({
          userId: subject.userId,
          conversationId: req.conversationId,
          messageId: req.assistantMessageId,
          content,
          status,
          error,
        });
        return true;
      } catch (err) {
        log('save_assistant_failed', err?.message);
        return false;
      }
    }

    async function streamOpenRouter({ systemPrompt, userMessage, history: hist, state: s }) {
      const messages = [{ role: 'system', content: systemPrompt }];
      if (Array.isArray(hist)) {
        for (const h of hist) {
          if (h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string') {
            messages.push({ role: h.role, content: h.content });
          }
        }
      }
      messages.push({ role: 'user', content: userMessage });

      const controller = new AbortController();
      active = {
        cancel: () => {
          s.cancelled = true;
          try { controller.abort(); } catch { /* ignore */ }
        },
      };
      if (s.cancelled) return { type: 'cancelled', text: '' };

      let text = '';
      try {
        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${cfg.openrouterApiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://mitra-ai.local',
            'X-Title': 'Mitra AI',
          },
          body: JSON.stringify({
            model: cfg.openrouterModel,
            models: [
              cfg.openrouterModel,
              'liquid/lfm-2.5-2.6b:free',
              'google/gemma-4-26b-a4b-it:free',
            ],
            messages,
            stream: true,
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          log('openrouter_error', `HTTP ${res.status}: ${errText}`);
          return { type: 'failed', text: '' };
        }

        const reader = res.body?.getReader();
        if (!reader) return { type: 'failed', text: '' };

        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          if (s.cancelled) {
            try { await reader.cancel(); } catch { /* ignore */ }
            return { type: 'cancelled', text };
          }
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data:')) continue;
            const dataStr = trimmed.slice(5).trim();
            if (dataStr === '[DONE]') {
              return { type: text ? 'complete' : 'empty', text };
            }
            try {
              const parsed = JSON.parse(dataStr);
              const chunk = parsed.choices?.[0]?.delta?.content;
              if (chunk) {
                text += chunk;
                send({ type: 'chunk', text: chunk });
              }
            } catch {
              // ignore malformed line
            }
          }
        }
        return { type: text ? 'complete' : 'empty', text };
      } catch (err) {
        if (s.cancelled || controller.signal.aborted) {
          return { type: 'cancelled', text };
        }
        log('openrouter_stream_error', err?.message);
        return { type: 'failed', text };
      }
    }

    function streamUpstream({ systemPrompt, message, state: s }) {
      return new Promise((resolve) => {
        let text = '';
        let settled = false;
        let ws = null;
        let connectTimer = null;
        let idleTimer = null;
        let totalTimer = null;

        const clearAll = () => {
          [connectTimer, idleTimer, totalTimer].forEach((t) => t !== null && timers.clearTimeout(t));
        };
        const finish = (type) => {
          if (settled) return;
          settled = true;
          clearAll();
          if (ws) {
            ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
            try {
              if (ws.readyState === 0 || ws.readyState === 1) ws.close(1000);
            } catch {
              /* ignore */
            }
          }
          resolve({ type, text });
        };
        const armIdle = () => {
          if (idleTimer !== null) timers.clearTimeout(idleTimer);
          idleTimer = timers.setTimeout(() => finish('timeout'), cfg.upstreamIdleTimeoutMs);
        };

        active = { cancel: () => { s.cancelled = true; finish('cancelled'); } };
        if (s.cancelled) return finish('cancelled');

        try {
          ws = new UpstreamWebSocket(cfg.upstreamUrl);
        } catch {
          return finish('failed');
        }
        connectTimer = timers.setTimeout(() => finish('timeout'), cfg.upstreamConnectTimeoutMs);
        totalTimer = timers.setTimeout(() => finish('timeout'), cfg.totalTimeoutMs);

        ws.onopen = () => {
          if (connectTimer !== null) timers.clearTimeout(connectTimer);
          connectTimer = null;
          try {
            // A fresh chatId per request: the provider keeps no state between
            // requests that we depend on; all context is supplied above.
            ws.send(JSON.stringify({ chatId: req.requestId, appId: cfg.upstreamAppId, systemPrompt, message }));
          } catch {
            finish('failed');
            return;
          }
          armIdle();
        };
        ws.onmessage = (event) => {
          if (typeof event?.data !== 'string') return finish('failed');
          armIdle();
          if (event.data === '') return;
          text += event.data;
          send({ type: 'chunk', text: event.data });
        };
        ws.onerror = () => finish('failed');
        ws.onclose = (event) => finish(event?.code === 1000 ? (text ? 'complete' : 'empty') : 'failed');
      });
    }
  }
}
