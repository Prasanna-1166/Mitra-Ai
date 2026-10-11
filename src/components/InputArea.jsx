import { useLayoutEffect, useRef } from 'react';
import PropTypes from 'prop-types';
import Icon from './Icon';
import { isSendKey } from '../lib/composer';

const MAX_HEIGHT = 200; // keep in sync with .composer-input max-height in index.css

const STATUS_TEXT = {
  connecting: 'Connecting to Mitra AI…',
  generating: 'Mitra AI is thinking…',
  streaming: 'Mitra AI is responding…',
};

const InputArea = ({ value, onChange, onSend, onStop, isGenerating, phase, textareaRef }) => {
  const localRef = useRef(null);
  const ref = textareaRef ?? localRef;
  const canSend = value.trim().length > 0 && !isGenerating;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [value, ref]);

  const submit = () => {
    const text = value.trim();
    if (isGenerating || !text) return;
    if (onSend(text) !== false) onChange('');
  };

  return (
    <footer className="composer">
      <form
        className="composer-inner"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="composer-box">
          <textarea
            ref={ref}
            className="composer-input"
            rows={1}
            value={value}
            placeholder="Message Mitra AI"
            aria-label="Message Mitra AI"
            aria-describedby="composer-hint"
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (isSendKey(e)) {
                e.preventDefault();
                submit();
              }
            }}
          />
          {isGenerating ? (
            <button
              type="button"
              className="send-btn is-stop"
              onClick={onStop}
              aria-label="Stop generating"
              title="Stop generating"
            >
              <Icon name="stop" size={16} filled />
            </button>
          ) : (
            <button
              type="submit"
              className="send-btn"
              disabled={!canSend}
              aria-label="Send message"
              title="Send message"
            >
              <Icon name="send" size={18} strokeWidth={2} />
            </button>
          )}
        </div>
        <p id="composer-hint" className={`composer-hint ${isGenerating ? '' : 'is-keys'}`}>
          {isGenerating
            ? (STATUS_TEXT[phase] ?? 'Mitra AI is responding…')
            : 'Enter to send · Shift+Enter for a new line'}
        </p>
      </form>
    </footer>
  );
};

InputArea.propTypes = {
  value: PropTypes.string.isRequired,
  onChange: PropTypes.func.isRequired,
  onSend: PropTypes.func.isRequired,
  onStop: PropTypes.func.isRequired,
  isGenerating: PropTypes.bool,
  phase: PropTypes.string,
  textareaRef: PropTypes.shape({ current: PropTypes.any }),
};

export default InputArea;
