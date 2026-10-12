// Wire protocol between the browser and the chat relay, plus request validation.
//
// client -> relay: { type:'request', requestId, userMessageId, assistantMessageId,
//                    message, depth?, conversationId (signed in), history (guest) }
//                  { type:'cancel' }
// relay -> client: { type:'accepted', usage } { type:'chunk', text }
//                  { type:'done', usage } { type:'error', code, message, usage?, retryable }

import { DEPTHS } from './instructions.js';

export const ERROR_CODES = {
  INVALID_REQUEST: 'invalid_request',
  QUOTA_EXCEEDED: 'quota_exceeded',
  RATE_LIMITED: 'rate_limited',
  NOT_FOUND: 'conversation_not_found',
  DUPLICATE: 'duplicate_request',
  UPSTREAM_FAILED: 'upstream_failed',
  UPSTREAM_TIMEOUT: 'upstream_timeout',
  UPSTREAM_EMPTY: 'upstream_empty',
  INTERNAL: 'internal',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v) => typeof v === 'string' && UUID.test(v);

const bad = (message) => ({ ok: false, code: ERROR_CODES.INVALID_REQUEST, message });

export function validateChatRequest(raw, { isGuest, cfg }) {
  if (!raw || typeof raw !== 'object' || raw.type !== 'request') return bad('Unexpected message.');
  if (!isUuid(raw.requestId) || !isUuid(raw.userMessageId) || !isUuid(raw.assistantMessageId)) {
    return bad('Missing or invalid identifiers.');
  }
  if (typeof raw.message !== 'string') return bad('Message must be text.');
  const message = raw.message.trim();
  if (!message) return bad('Message is empty.');
  if (message.length > cfg.maxMessageChars) {
    return bad(`Message is longer than ${cfg.maxMessageChars} characters.`);
  }
  const value = {
    requestId: raw.requestId.toLowerCase(),
    userMessageId: raw.userMessageId.toLowerCase(),
    assistantMessageId: raw.assistantMessageId.toLowerCase(),
    message,
    depth: DEPTHS.includes(raw.depth) ? raw.depth : undefined,
  };
  if (isGuest) {
    const history = raw.history ?? [];
    if (!Array.isArray(history) || history.length > cfg.contextMaxMessages * 2) {
      return bad('History is invalid.');
    }
    value.history = [];
    for (const item of history) {
      if (!item || (item.role !== 'user' && item.role !== 'assistant') || typeof item.content !== 'string') {
        return bad('History is invalid.');
      }
      value.history.push({ role: item.role, content: item.content.slice(0, 60000) });
    }
  } else {
    if (!isUuid(raw.conversationId)) return bad('Missing conversation.');
    value.conversationId = raw.conversationId.toLowerCase();
  }
  return { ok: true, value };
}

export function messageForCode(code) {
  switch (code) {
    case ERROR_CODES.QUOTA_EXCEEDED:
      return 'You have used your question allowance.';
    case ERROR_CODES.RATE_LIMITED:
      return 'Too many requests. Please wait a moment and try again.';
    case ERROR_CODES.NOT_FOUND:
      return 'That conversation could not be found.';
    case ERROR_CODES.DUPLICATE:
      return 'This request was already processed.';
    case ERROR_CODES.UPSTREAM_TIMEOUT:
      return 'The AI service took too long to respond.';
    case ERROR_CODES.UPSTREAM_EMPTY:
      return 'The AI service finished without sending an answer.';
    case ERROR_CODES.UPSTREAM_FAILED:
      return 'The AI service could not complete the answer.';
    case ERROR_CODES.INVALID_REQUEST:
      return 'The request was not valid.';
    default:
      return 'Something went wrong on the server.';
  }
}
