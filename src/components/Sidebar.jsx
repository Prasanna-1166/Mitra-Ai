import React from 'react';
import PropTypes from 'prop-types';

const Sidebar = ({ sessions, activeSessionId, onSwitchSession, onNewChat, onDeleteSession, onDeleteAll, isOpen, toggleSidebar }) => {
    return (
        <>
            {/* Mobile Overlay */}
            <div
                className={`sidebar-overlay ${isOpen ? 'open' : ''}`}
                onClick={toggleSidebar}
            />

            {/* Sidebar Container */}
            <aside className={`sidebar ${isOpen ? 'open' : ''}`}>
                <button onClick={onNewChat} className="new-chat-full-btn">
                    <span>+ New Chat</span>
                </button>

                <div className="sessions-list">
                    <div className="sessions-label">Recent Chats</div>
                    {sessions.map((session) => (
                        <div
                            key={session.id}
                            className={`session-item ${session.id === activeSessionId ? 'active' : ''}`}
                            onClick={() => {
                                onSwitchSession(session.id);
                                if (window.innerWidth <= 768) toggleSidebar();
                            }}
                        >
                            <div className="session-title">
                                {session.title || 'New Chat'}
                            </div>
                            <button
                                className="delete-session-btn"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onDeleteSession(session.id);
                                }}
                                title="Delete Chat"
                            >
                                <svg viewBox="0 0 24 24" fill="none" width="16" height="16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <polyline points="3 6 5 6 21 6"></polyline>
                                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                                </svg>
                            </button>
                        </div>
                    ))}
                    {sessions.length === 0 && (
                        <div className="no-sessions">No active chats</div>
                    )}
                </div>

                {sessions.length > 0 && (
                    <button onClick={onDeleteAll} className="delete-all-btn">
                        <svg viewBox="0 0 24 24" fill="none" width="16" height="16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="3 6 5 6 21 6"></polyline>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                        </svg>
                        <span>Delete All History</span>
                    </button>
                )}
            </aside>
        </>
    );
};

Sidebar.propTypes = {
    sessions: PropTypes.arrayOf(PropTypes.shape({
        id: PropTypes.string.isRequired,
        title: PropTypes.string,
    })).isRequired,
    activeSessionId: PropTypes.string,
    onSwitchSession: PropTypes.func.isRequired,
    onNewChat: PropTypes.func.isRequired,
    onDeleteSession: PropTypes.func.isRequired,
    onDeleteAll: PropTypes.func,
    isOpen: PropTypes.bool.isRequired,
    toggleSidebar: PropTypes.func.isRequired,
};

export default Sidebar;
