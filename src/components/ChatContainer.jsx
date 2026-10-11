import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import Icon from './Icon';
import MessageBubble, { PendingIndicator } from './MessageBubble';
import { isNearBottom } from '../lib/scroll';

const SUGGESTIONS = [
  { label: 'Explain a difficult concept', prompt: 'Explain this concept in simple terms: ' },
  { label: 'Write or debug code', prompt: 'Help me write or debug this code: ' },
  { label: 'Plan a project', prompt: 'Help me plan a project. Here is the goal: ' },
  { label: 'Summarize a topic', prompt: 'Summarize the key points of this topic: ' },
];

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

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
const ChatContainer = ({
  messages,
  request,
  welcomeError,
  onRetryMessage,
  onRetryWelcome,
  onPickSuggestion,
}) => {
  const scrollerRef = useRef(null);
  const stickRef = useRef(true); // follow new content only while the reader is at the bottom
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

  // Runs for every streamed update: an instant jump (never per-token smooth
  // scrolling), and only when the user has not scrolled away.
  useLayoutEffect(() => {
    if (messages[messages.length - 1]?.role === 'user') stickRef.current = true; // they just sent
    if (stickRef.current) scrollToBottom();
  }, [messages, request, scrollToBottom]);

  const hasUser = messages.some((m) => m.role === 'user');
  const lastIndex = messages.length - 1;
  const welcomePending =
    request?.kind === 'welcome' && !messages.some((m) => m.id === request.messageId);
  const busy = Boolean(request);

  return (
    <div className="chat-scroll-wrap">
      <div className="chat-scroll" ref={scrollerRef} onScroll={handleScroll}>
        <div className="chat-column">
          {messages.length === 0 && (
            <div className="empty-state">
              <h1>How can I help you today?</h1>
              <p>Ask a question, or start from one of these.</p>
              {welcomePending && <PendingIndicator phase={request.phase} />}
              {welcomeError && (
                <div className="notice is-error" role="alert">
                  <Icon name="alert" size={16} />
                  <div className="notice-text">
                    <strong>Couldn&apos;t load the greeting</strong>
                    <span>{welcomeError} You can still send a message.</span>
                  </div>
                  <button type="button" className="btn btn-sm" onClick={onRetryWelcome}>
                    <Icon name="retry" size={14} />
                    Retry
                  </button>
                </div>
              )}
              <Suggestions onPick={onPickSuggestion} />
            </div>
          )}

          <div role="log" aria-label="Conversation">
            {messages.map((m, i) => (
              <MessageBubble
                key={m.id}
                message={m}
                phase={request?.messageId === m.id ? request.phase : undefined}
                canRetry={!busy && i === lastIndex && m.status === 'error'}
                onRetry={onRetryMessage}
              />
            ))}
          </div>

          {messages.length > 0 && !hasUser && !busy && (
            <div className="suggestions-block">
              <p>Try asking</p>
              <Suggestions onPick={onPickSuggestion} />
            </div>
          )}
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
  request: PropTypes.shape({
    kind: PropTypes.string,
    messageId: PropTypes.string,
    phase: PropTypes.string,
  }),
  welcomeError: PropTypes.string,
  onRetryMessage: PropTypes.func.isRequired,
  onRetryWelcome: PropTypes.func.isRequired,
  onPickSuggestion: PropTypes.func.isRequired,
};

export default ChatContainer;
