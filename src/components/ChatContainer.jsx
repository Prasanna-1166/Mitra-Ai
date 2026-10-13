import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import Icon from './Icon';
import MessageBubble from './MessageBubble';
import { isNearBottom } from '../lib/scroll';

const SUGGESTIONS = [
  { label: 'Explain a difficult concept', prompt: 'Explain this concept in simple terms: ' },
  { label: 'Write or debug code', prompt: 'Help me write or debug this code: ' },
  { label: 'Plan a project', prompt: 'Help me plan a project. Here is the goal: ' },
  { label: 'Summarize a topic', prompt: 'Summarize the key points of this topic: ' },
];

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// Suggestions fill the composer; the user edits and sends them through the
// normal send path (no separate request code).
export const Suggestions = ({ onPick }) => (
  <ul className="suggestions" aria-label="Prompt suggestions">
    {SUGGESTIONS.map((s) => (
      <li key={s.label}>
        <button type="button" className="suggestion" onClick={() => onPick(s.prompt)}>
          {s.label}
        </button>
      </li>
    ))}
  </ul>
);
Suggestions.propTypes = { onPick: PropTypes.func.isRequired };

// Mount with key={sessionId} so each conversation starts pinned to its end.
const ChatContainer = ({ messages, request, loading, hasMore, onLoadOlder, onRetryMessage, onPickSuggestion }) => {
  const scrollerRef = useRef(null);
  const stickRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth && !prefersReducedMotion() ? 'smooth' : 'auto' });
  }, []);

  const handleScroll = () => {
    const near = isNearBottom(scrollerRef.current);
    stickRef.current = near;
    setAtBottom(near);
  };

  // Follow streamed text only while the reader is at the bottom; instant jumps,
  // never per-token smooth scrolling.
  useLayoutEffect(() => {
    if (messages[messages.length - 1]?.role === 'user') stickRef.current = true;
    if (stickRef.current) scrollToBottom();
  }, [messages, request, scrollToBottom]);

  const lastIndex = messages.length - 1;
  const busy = Boolean(request);

  return (
    <div className="chat-scroll-wrap">
      <div className="chat-scroll" ref={scrollerRef} onScroll={handleScroll}>
        <div className="chat-column">
          {loading && <p className="sidebar-empty" role="status">Loading conversation…</p>}
          {!loading && messages.length === 0 && (
            <div className="empty-state">
              <h1>How can I help you today?</h1>
              <p>Ask a question, or start from one of these.</p>
              <Suggestions onPick={onPickSuggestion} />
            </div>
          )}

          {hasMore && (
            <div className="load-older">
              <button type="button" className="btn btn-sm" onClick={onLoadOlder}>Load earlier messages</button>
            </div>
          )}

          <div role="log" aria-label="Conversation">
            {messages.map((m, i) => (
              <MessageBubble
                key={m.id}
                message={m}
                phase={request?.messageId === m.id ? request.phase : undefined}
                canRetry={!busy && i === lastIndex && m.status === 'error'}
                canRegenerate={!busy && i === lastIndex && (m.status === 'complete' || m.status === 'stopped')}
                onRetry={onRetryMessage}
              />
            ))}
          </div>
        </div>
      </div>

      {!atBottom && messages.length > 0 && (
        <button
          type="button"
          className="jump-btn"
          onClick={() => {
            stickRef.current = true;
            scrollToBottom(true);
          }}
        >
          <Icon name="arrowDown" size={14} />
          Jump to latest
        </button>
      )}
    </div>
  );
};

ChatContainer.propTypes = {
  messages: PropTypes.arrayOf(PropTypes.object).isRequired,
  request: PropTypes.shape({ messageId: PropTypes.string, phase: PropTypes.string }),
  loading: PropTypes.bool,
  hasMore: PropTypes.bool,
  onLoadOlder: PropTypes.func,
  onRetryMessage: PropTypes.func.isRequired,
  onPickSuggestion: PropTypes.func.isRequired,
};

export default ChatContainer;
