import { Children, isValidElement, memo } from 'react';
import PropTypes from 'prop-types';
import Markdown from 'react-markdown';
import Icon from './Icon';
import { useCopy } from '../hooks/useCopy';

// Flatten react-markdown's children (a string for code) into plain text.
const toText = (node) => {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(toText).join('');
  return toText(node.props?.children);
};

const COPY_LABEL = { idle: 'Copy', copied: 'Copied', failed: 'Copy failed' };

const CopyButton = ({ text, label, className = '' }) => {
  const { status, copy } = useCopy();
  return (
    <>
      <button
        type="button"
        className={`copy-btn ${className} ${status !== 'idle' ? `is-${status}` : ''}`}
        onClick={() => copy(text)}
        aria-label={label}
      >
        <Icon name={status === 'copied' ? 'check' : 'copy'} size={14} />
        <span aria-hidden="true">{COPY_LABEL[status]}</span>
      </button>
      <span className="sr-only" role="status">
        {status === 'copied' ? 'Copied to clipboard' : status === 'failed' ? 'Copy failed' : ''}
      </span>
    </>
  );
};
CopyButton.propTypes = {
  text: PropTypes.string.isRequired,
  label: PropTypes.string.isRequired,
  className: PropTypes.string,
};

const CodeBlock = ({ className, children }) => {
  const language = /language-([\w+#.-]+)/.exec(className ?? '')?.[1];
  const code = toText(children).replace(/\n$/, '');
  return (
    <div className="code-block">
      <div className="code-header">
        <span className="code-language">{language ?? 'text'}</span>
        <CopyButton text={code} label={`Copy ${language ?? ''} code`.replace('  ', ' ')} />
      </div>
      {/* focusable so keyboard users can scroll long lines */}
      <pre tabIndex={0} aria-label={language ? `${language} code` : 'Code'}>
        <code className={className}>{code}</code>
      </pre>
    </div>
  );
};
CodeBlock.propTypes = { className: PropTypes.string, children: PropTypes.node };

// react-markdown v10 has no `inline` prop. Fenced code always arrives wrapped
// in <pre>, so the block container is built there; bare <code> stays inline.
const markdownComponents = {
  pre({ children }) {
    const child = Children.toArray(children)[0];
    if (isValidElement(child)) {
      return <CodeBlock className={child.props.className}>{child.props.children}</CodeBlock>;
    }
    return <pre>{children}</pre>;
  },
  code({ className, children }) {
    return <code className={className}>{children}</code>;
  },
  a({ href, children }) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
};

const PHASE_TEXT = { connecting: 'Connecting…', generating: 'Thinking…' };

export const PendingIndicator = ({ phase }) => (
  <div className="pending">
    <span className="pending-dots" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
    <span>{PHASE_TEXT[phase] ?? 'Thinking…'}</span>
  </div>
);
PendingIndicator.propTypes = { phase: PropTypes.string };

const MessageBubble = ({ message, phase, canRetry = false, canRegenerate = false, onRetry }) => {
  const { id, role, content, status, error } = message;

  if (role === 'user') {
    return (
      <article className="message user" aria-label="You">
        <div className="user-body">{content}</div>
      </article>
    );
  }

  const hasText = content.trim().length > 0;
  const isPartial = hasText && (status === 'error' || status === 'stopped');
  const isBusy = status === 'pending' || status === 'streaming';

  return (
    <article className="message assistant" aria-label="Mitra AI" aria-busy={isBusy}>
      <div className="author">Mitra AI</div>

      {status === 'pending' && <PendingIndicator phase={phase} />}

      {hasText && (
        <div className={`markdown ${isPartial ? 'is-partial' : ''}`}>
          <Markdown components={markdownComponents}>{content}</Markdown>
        </div>
      )}

      {status === 'error' && (
        <div className="notice is-error" role="alert">
          <Icon name="alert" size={16} />
          <div className="notice-text">
            <strong>{hasText ? 'Response incomplete' : 'Request failed'}</strong>
            <span>{error}</span>
          </div>
          {canRetry && (
            <button type="button" className="btn btn-sm" onClick={() => onRetry?.(id)}>
              <Icon name="retry" size={14} />
              Retry
            </button>
          )}
        </div>
      )}

      {status === 'stopped' && (
        <div className="notice is-muted">
          <span>{hasText ? 'Generation stopped. This response is incomplete.' : 'Generation stopped.'}</span>
        </div>
      )}

      {!isBusy && (hasText || (canRegenerate && status === 'stopped')) && (
        <div className="message-actions">
          {hasText && <CopyButton text={content} label="Copy response" className="action" />}
          {canRegenerate && (
            <button
              type="button" className="copy-btn action" onClick={() => onRetry?.(id)}
              aria-label="Regenerate response" title="Regenerate (uses one question from your allowance)"
            >
              <Icon name="retry" size={14} />
              <span aria-hidden="true">Regenerate</span>
            </button>
          )}
        </div>
      )}
    </article>
  );
};

MessageBubble.propTypes = {
  message: PropTypes.shape({
    id: PropTypes.string.isRequired,
    role: PropTypes.oneOf(['user', 'assistant']).isRequired,
    content: PropTypes.string.isRequired,
    status: PropTypes.string,
    error: PropTypes.string,
  }).isRequired,
  phase: PropTypes.string,
  canRetry: PropTypes.bool,
  canRegenerate: PropTypes.bool,
  onRetry: PropTypes.func,
};

export default memo(MessageBubble);
