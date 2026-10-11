import { useEffect, useRef, useState } from 'react';
import BrandMark from './components/BrandMark';
import ChatContainer from './components/ChatContainer';
import ConfirmDialog from './components/ConfirmDialog';
import Icon from './components/Icon';
import InputArea from './components/InputArea';
import Sidebar from './components/Sidebar';
import { useChat } from './hooks/useChat';
import { useMediaQuery } from './hooks/useMediaQuery';
import { useTheme } from './hooks/useTheme';
import { conversationToMarkdown, exportFilename } from './lib/chatState';
import { downloadText } from './lib/download';

const ANNOUNCEMENTS = {
  connecting: 'Connecting to Mitra AI.',
  generating: 'Mitra AI is thinking.',
  streaming: 'Mitra AI is responding.',
  complete: 'Response complete.',
  stopped: 'Generation stopped.',
  error: 'The request failed.',
};

const App = () => {
  const { state, controller } = useChat();
  const { theme, toggleTheme } = useTheme();
  const isDesktop = useMediaQuery('(min-width: 861px)');
  const [desktopCollapsed, setDesktopCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [dialog, setDialog] = useState(null); // { type: 'clear' | 'delete' | 'deleteAll', id? }
  const [draft, setDraft] = useState('');
  const textareaRef = useRef(null);
  const toggleRef = useRef(null);

  const { sessions, activeSessionId, request, outcome, welcomeErrors, storageWarning } = state;
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;
  const messages = activeSession?.messages ?? [];
  const isGenerating = Boolean(request);

  const sidebarOpen = isDesktop ? !desktopCollapsed : drawerOpen;
  const drawerActive = !isDesktop && drawerOpen;

  const closeDrawer = () => setDrawerOpen(false);
  const toggleSidebar = () => {
    if (isDesktop) setDesktopCollapsed((c) => !c);
    else setDrawerOpen((o) => !o);
  };
  const closeSidebar = () => {
    if (isDesktop) setDesktopCollapsed(true);
    else closeDrawer();
    toggleRef.current?.focus();
  };

  // Escape closes the mobile drawer.
  useEffect(() => {
    if (!drawerActive) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setDrawerOpen(false);
        toggleRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerActive]);

  const handleNewChat = () => {
    controller.newChat();
    closeDrawer();
    textareaRef.current?.focus();
  };
  const handleSelect = (id) => {
    controller.switchSession(id);
    closeDrawer();
  };
  const handlePickSuggestion = (prompt) => {
    setDraft(prompt);
    textareaRef.current?.focus();
  };
  const handleExport = () => {
    if (activeSession) {
      downloadText(exportFilename(activeSession), conversationToMarkdown(activeSession));
    }
  };

  const confirmDialog = (() => {
    if (!dialog) return {};
    if (dialog.type === 'clear') {
      return {
        title: 'Clear this conversation?',
        description:
          'All messages in this chat will be removed from this browser, and Mitra AI will start again with a fresh greeting.',
        confirmLabel: 'Clear conversation',
        run: () => controller.clearSession(),
      };
    }
    if (dialog.type === 'delete') {
      const target = sessions.find((s) => s.id === dialog.id);
      return {
        title: 'Delete this chat?',
        description: `“${target?.title ?? 'This chat'}” will be removed from this browser. This can’t be undone.`,
        confirmLabel: 'Delete chat',
        run: () => controller.deleteSession(dialog.id),
      };
    }
    return {
      title: 'Delete all chats?',
      description:
        'Every saved conversation will be removed from this browser. This can’t be undone. It does not affect anything the AI service may have already received.',
      confirmLabel: 'Delete all',
      run: () => controller.deleteAll(),
    };
  })();

  const announcement = request ? ANNOUNCEMENTS[request.phase] : (ANNOUNCEMENTS[outcome] ?? '');

  return (
    <div className="app" data-sidebar={sidebarOpen ? 'open' : 'closed'}>
      <Sidebar
        sessions={sessions}
        activeSessionId={activeSessionId}
        isOpen={sidebarOpen}
        onClose={closeSidebar}
        onSelect={handleSelect}
        onNewChat={handleNewChat}
        onRename={controller.renameSession}
        onDelete={(id) => setDialog({ type: 'delete', id })}
        onDeleteAll={() => setDialog({ type: 'deleteAll' })}
        storageWarning={storageWarning}
        onDismissWarning={controller.dismissStorageWarning}
      />
      {drawerActive && <div className="scrim" onClick={closeDrawer} aria-hidden="true" />}

      <div className="workspace" inert={drawerActive}>
        <header className="app-header">
          <button
            ref={toggleRef}
            type="button"
            className="icon-btn"
            onClick={toggleSidebar}
            aria-label={sidebarOpen ? 'Close sidebar' : 'Open sidebar'}
            aria-expanded={sidebarOpen}
            aria-controls="chat-sidebar"
            title={sidebarOpen ? 'Close sidebar' : 'Open sidebar'}
          >
            <Icon name="sidebar" />
          </button>
          <div className="brand">
            <BrandMark />
            <span>Mitra AI</span>
          </div>
          <span className="header-title" title={activeSession?.title}>
            {messages.length > 0 ? activeSession?.title : ''}
          </span>
          <div className="header-actions">
            <button
              type="button"
              className="icon-btn"
              onClick={handleExport}
              disabled={messages.length === 0}
              aria-label="Export conversation as Markdown"
              title="Export conversation"
            >
              <Icon name="download" />
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setDialog({ type: 'clear' })}
              disabled={!activeSession || messages.length === 0}
              aria-label="Clear conversation"
              title="Clear conversation"
            >
              <Icon name="eraser" />
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={toggleTheme}
              aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            >
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
            </button>
            {!sidebarOpen && (
              <button
                type="button"
                className="icon-btn"
                onClick={handleNewChat}
                aria-label="New chat"
                title="New chat"
              >
                <Icon name="plus" />
              </button>
            )}
          </div>
        </header>

        <main className="chat-main">
          <ChatContainer
            key={activeSessionId ?? 'none'}
            messages={messages}
            request={request?.sessionId === activeSessionId ? request : null}
            welcomeError={activeSessionId ? welcomeErrors[activeSessionId] : undefined}
            onRetryMessage={controller.retryMessage}
            onRetryWelcome={controller.retryWelcome}
            onPickSuggestion={handlePickSuggestion}
          />
          <InputArea
            value={draft}
            onChange={setDraft}
            onSend={controller.sendMessage}
            onStop={controller.stopGeneration}
            isGenerating={isGenerating}
            phase={request?.phase}
            textareaRef={textareaRef}
          />
        </main>
      </div>

      <ConfirmDialog
        open={dialog !== null}
        title={confirmDialog.title}
        description={confirmDialog.description}
        confirmLabel={confirmDialog.confirmLabel}
        onCancel={() => setDialog(null)}
        onConfirm={() => {
          confirmDialog.run?.();
          setDialog(null);
        }}
      />

      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
};

export default App;
