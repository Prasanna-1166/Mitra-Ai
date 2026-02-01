import React, { useEffect, useRef } from 'react';
import PropTypes from 'prop-types';
import MessageBubble from './MessageBubble';

const ChatContainer = ({ messages, isTyping }) => {
    const bottomRef = useRef(null);

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages, isTyping]);

    return (
        <div className="chat-container">
            {messages.length === 0 ? (
                <div className="welcome-screen fade-in-up">
                    <h1>How can I help you today?</h1>
                </div>
            ) : (
                <>
                    {messages.map((msg) => (
                        <MessageBubble key={msg.id} role={msg.role} content={msg.content} />
                    ))}
                    {isTyping && (
                        <div className="typing-indicator">
                            <div className="typing-content">
                                <div className="typing-dot"></div>
                                <div className="typing-dot"></div>
                                <div className="typing-dot"></div>
                            </div>
                        </div>
                    )}
                    <div ref={bottomRef} />
                </>
            )}
        </div>
    );
};

ChatContainer.propTypes = {
    messages: PropTypes.arrayOf(
        PropTypes.shape({
            id: PropTypes.string.isRequired,
            role: PropTypes.string.isRequired,
            content: PropTypes.string.isRequired,
        })
    ).isRequired,
    isTyping: PropTypes.bool.isRequired,
};

export default ChatContainer;
