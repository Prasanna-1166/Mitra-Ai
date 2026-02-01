import React, { useState, useRef, useEffect } from 'react';
import PropTypes from 'prop-types';

const InputArea = ({ onSendMessage, isGenerating, onCancel, onClear }) => {
    const [input, setInput] = useState('');
    const textareaRef = useRef(null);

    useEffect(() => {
        if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
            textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px';
        }
    }, [input]);

    const handleSubmit = (e) => {
        e.preventDefault();
        if (isGenerating) {
            onCancel();
            return;
        }
        if (input.trim()) {
            onSendMessage(input.trim());
            setInput('');
            // Reset height
            if (textareaRef.current) {
                textareaRef.current.style.height = 'auto';
            }
        }
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmit(e);
        }
    };

    return (
        <footer className="input-area-container">
            <form onSubmit={handleSubmit} className="input-form">
                <div className="input-wrapper">
                    {onClear && (
                        <button
                            type="button"
                            onClick={onClear}
                            disabled={isGenerating}
                            className="clear-button"
                            title="Clear Chat"
                        >
                            <svg viewBox="0 0 24 24" fill="none" width="18" height="18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="3 6 5 6 21 6"></polyline>
                                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                            </svg>
                        </button>
                    )}
                    <textarea
                        ref={textareaRef}
                        rows={1}
                        placeholder={isGenerating ? "Wait for response..." : "Type a message..."}
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={handleKeyDown}
                        disabled={isGenerating}
                        className="chat-input"
                    />
                    <button
                        type="submit"
                        disabled={!isGenerating && !input.trim()}
                        className="send-button"
                        aria-label={isGenerating ? "Stop generating" : "Send message"}
                        title={isGenerating ? "Stop generating" : "Send message"}
                    >
                        {isGenerating ? (
                            // Square Stop Icon
                            <svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
                                <rect x="6" y="6" width="12" height="12" rx="2" />
                            </svg>
                        ) : (
                            // Send Arrow Icon
                            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M2.01 21L23 12L2.01 3L2 10L17 12L2 14L2.01 21Z" fill="currentColor" />
                            </svg>
                        )}
                    </button>
                </div>
            </form>
        </footer>
    );
};

InputArea.propTypes = {
    onSendMessage: PropTypes.func.isRequired,
    isGenerating: PropTypes.bool,
    onCancel: PropTypes.func,
    onClear: PropTypes.func
};

export default InputArea;
