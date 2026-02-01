import React, { useState } from 'react';
import PropTypes from 'prop-types';
import Markdown from 'react-markdown';

const CodeBlock = ({ children, className }) => {
    const [copied, setCopied] = useState(false);
    const language = className ? className.replace('language-', '') : '';
    const code = String(children).replace(/\n$/, '');

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy:', err);
        }
    };

    return (
        <div className="code-block-wrapper">
            <div className="code-block-header">
                <span className="code-language">{language || 'code'}</span>
                <button
                    onClick={handleCopy}
                    className="copy-code-btn"
                    aria-label="Copy code"
                >
                    {copied ? (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <polyline points="20 6 9 17 4 12"></polyline>
                        </svg>
                    ) : (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                        </svg>
                    )}
                    <span>{copied ? 'Copied!' : 'Copy'}</span>
                </button>
            </div>
            <pre>
                <code className={className}>{children}</code>
            </pre>
        </div>
    );
};

CodeBlock.propTypes = {
    children: PropTypes.node,
    className: PropTypes.string
};

const MessageBubble = ({ role, content }) => {
    const isUser = role === 'user';

    return (
        <div className={`message ${isUser ? 'user' : 'assistant'}`}>
            <div className="message-content">
                <Markdown
                    components={{
                        code({ node, inline, className, children, ...props }) {
                            return inline ? (
                                <code className={className} {...props}>
                                    {children}
                                </code>
                            ) : (
                                <CodeBlock className={className}>
                                    {children}
                                </CodeBlock>
                            );
                        }
                    }}
                >
                    {content}
                </Markdown>
            </div>
        </div>
    );
};

MessageBubble.propTypes = {
    role: PropTypes.oneOf(['user', 'assistant']).isRequired,
    content: PropTypes.string.isRequired,
};

export default MessageBubble;
