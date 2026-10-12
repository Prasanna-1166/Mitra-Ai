import { useEffect, useState } from 'react';
import PropTypes from 'prop-types';
import Icon from './Icon';
import { formatRelativeTime, matchesSearch } from '../lib/chatState';

const Sidebar = ({
  sessions,
  activeSessionId,
  isOpen,
  onClose,
  onSelect,
  onNewChat,
  onRename,
  onDelete,
  onDeleteAll,
  storageWarning,
  onDismissWarning,
  isGuest,
  loading,
  hasMore,
  onLoadMore,
  onRemoteSearch,
}) => {
  const [query, setQuery] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [draftTitle, setDraftTitle] = useState('');

  const [remoteIds, setRemoteIds] = useState({ query: '', ids: null });
  const searching = query.trim().length > 0;

  // Signed-in users also search message text on the server (debounced).
  useEffect(() => {
    const q = query.trim();
    if (!q || !onRemoteSearch) return undefined;
    let cancelled = false;
    const timer = setTimeout(() => {
      onRemoteSearch(q)
        .then((ids) => {
          if (!cancelled) setRemoteIds({ query: q, ids });
        })
        .catch(() => {});
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, onRemoteSearch]);

  const remote = remoteIds.query === query.trim() ? remoteIds.ids : null;
  const visible = sessions.filter((s) => matchesSearch(s, query) || (remote && remote.has(s.id)));

  const startRename = (session) => {
    setEditingId(session.id);
    setDraftTitle(session.title);
  };
  const commitRename = (id) => {
    onRename(id, draftTitle);
    setEditingId(null);
  };

  return (
    <aside
      id="chat-sidebar"
      className="sidebar"
      aria-label="Chat history"
      inert={!isOpen}
    >
      <div className="sidebar-top">
        <span className="sidebar-heading">Chats</span>
        <button
          type="button"
          className="icon-btn"
          onClick={onClose}
          aria-label="Close sidebar"
          title="Close sidebar"
        >
          <Icon name="x" />
        </button>
      </div>

      <div className="sidebar-tools">
        <button type="button" className="btn btn-block" onClick={onNewChat}>
          <Icon name="plus" size={16} />
          New chat
        </button>
        <div className="search-field">
          <Icon name="search" size={16} />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats"
            aria-label="Search chats"
          />
        </div>
      </div>

      <nav className="session-nav" aria-label="Saved chats">
        {loading ? (
          <p className="sidebar-empty" role="status">Loading your chats…</p>
        ) : sessions.length === 0 ? (
          <p className="sidebar-empty">No saved chats yet.</p>
        ) : visible.length === 0 ? (
          <p className="sidebar-empty" role="status">
            No chats match &ldquo;{query.trim()}&rdquo;.
          </p>
        ) : (
          <ul className="session-list">
            {visible.map((session) => {
              const active = session.id === activeSessionId;
              return (
                <li key={session.id} className={`session ${active ? 'is-active' : ''}`}>
                  {editingId === session.id ? (
                    <form
                      className="session-edit"
                      onSubmit={(e) => {
                        e.preventDefault();
                        commitRename(session.id);
                      }}
                    >
                      <input
                        autoFocus
                        value={draftTitle}
                        maxLength={80}
                        aria-label="Chat name"
                        onChange={(e) => setDraftTitle(e.target.value)}
                        onFocus={(e) => e.target.select()}
                        onBlur={() => commitRename(session.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') {
                            e.preventDefault();
                            setEditingId(null);
                          }
                        }}
                      />
                    </form>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="session-main"
                        aria-current={active ? 'true' : undefined}
                        onClick={() => onSelect(session.id)}
                      >
                        <span className="session-title">{session.title}</span>
                        <span className="session-meta">
                          {formatRelativeTime(session.updatedAt)}

                        </span>
                      </button>
                      <div className="session-actions">
                        <button
                          type="button"
                          className="icon-btn icon-btn-sm"
                          onClick={() => startRename(session)}
                          aria-label={`Rename chat: ${session.title}`}
                          title="Rename"
                        >
                          <Icon name="pencil" size={14} />
                        </button>
                        <button
                          type="button"
                          className="icon-btn icon-btn-sm"
                          onClick={() => onDelete(session.id)}
                          aria-label={`Delete chat: ${session.title}`}
                          title="Delete"
                        >
                          <Icon name="trash" size={14} />
                        </button>
                      </div>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {hasMore && !searching && (
          <button type="button" className="btn btn-sm btn-quiet load-more" onClick={onLoadMore}>Load more chats</button>
        )}
      </nav>

      <div className="sidebar-footer">
        {storageWarning && (
          <div className="notice is-warn" role="alert">
            <span>{storageWarning}</span>
            <button type="button" className="icon-btn icon-btn-sm" onClick={onDismissWarning} aria-label="Dismiss warning">
              <Icon name="x" size={14} />
            </button>
          </div>
        )}
        <button type="button" className="btn btn-block btn-quiet" onClick={onDeleteAll} disabled={sessions.length === 0}>
          <Icon name="trash" size={16} />
          Delete all chats
        </button>
        <p className="privacy-note">
          {isGuest
            ? 'Guest chats are saved in this browser only. '
            : 'Chats are saved to your account. '}
          Your messages are sent to an external AI service to generate replies.
        </p>
      </div>
    </aside>
  );
};

Sidebar.propTypes = {
  sessions: PropTypes.arrayOf(PropTypes.object).isRequired,
  activeSessionId: PropTypes.string,
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  onSelect: PropTypes.func.isRequired,
  onNewChat: PropTypes.func.isRequired,
  onRename: PropTypes.func.isRequired,
  onDelete: PropTypes.func.isRequired,
  onDeleteAll: PropTypes.func.isRequired,
  storageWarning: PropTypes.string,
  onDismissWarning: PropTypes.func.isRequired,
  isGuest: PropTypes.bool,
  loading: PropTypes.bool,
  hasMore: PropTypes.bool,
  onLoadMore: PropTypes.func,
  onRemoteSearch: PropTypes.func,
};

export default Sidebar;
