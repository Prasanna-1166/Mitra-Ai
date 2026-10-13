import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AccountMenu from './components/AccountMenu';
import AuthDialog, { ResetPasswordDialog } from './components/AuthDialog';
import BrandMark from './components/BrandMark';
import ChatContainer from './components/ChatContainer';
import ConfirmDialog from './components/ConfirmDialog';
import Icon from './components/Icon';
import ImportDialog from './components/ImportDialog';
import InputArea from './components/InputArea';
import LimitDialog from './components/LimitDialog';
import MemoryBanner from './components/MemoryBanner';
import ProfileDialog from './components/ProfileDialog';
import SettingsDialog from './components/SettingsDialog';
import Sidebar from './components/Sidebar';
import UsageBadge from './components/UsageBadge';
import { config } from './config';
import { useAccountData } from './hooks/useAccountData';
import { useAuth } from './hooks/useAuth';
import { useChat } from './hooks/useChat';
import { useMediaQuery } from './hooks/useMediaQuery';
import { useProfile } from './hooks/useProfile';
import { useTheme } from './hooks/useTheme';
import { conversationToMarkdown, exportFilename } from './lib/chatState';
import { downloadText } from './lib/download';
import { loadHistory, saveHistory } from './lib/storage';
import { configProblems, functionUrl, supabase, supabasePublishableKey } from './lib/supabaseClient';
import { deleteAccount } from './services/authService';
import { createCloudStore, importGuestHistory } from './services/conversationService';

const ANNOUNCEMENTS = {
  connecting: 'Connecting to Mitra AI.',
  generating: 'Mitra AI is thinking.',
  streaming: 'Mitra AI is responding.',
  complete: 'Response complete.',
  stopped: 'Generation stopped.',
  error: 'The request failed.',
};

const safeStorage = () => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};
const skipKey = (userId) => `mitra-ai:import-skipped:${userId}`;
const signatureOf = (sessions) => sessions.map((s) => `${s.id}:${s.updatedAt}`).sort().join('|');

const App = () => {
  const auth = useAuth();
  const { service: authService } = auth;
  const user = auth.user;
  const { theme, toggleTheme } = useTheme();
  const isDesktop = useMediaQuery('(min-width: 861px)');

  const [appNotice, setAppNotice] = useState(null);
  const handleAuthProblem = useCallback(() => {
    // The server rejected our session (expired or revoked): drop it and ask to sign in again.
    authService?.signOut().catch(() => {});
    setAppNotice('Your session has expired. Please sign in again.');
  }, [authService]);

  const { state, controller } = useChat({ userId: user?.id ?? null, authLoading: auth.loading, onAuthProblem: handleAuthProblem });
  const account = useAccountData({ userId: user?.id ?? null, controller });
  const { state: profileState, manager: profileManager } = useProfile(user?.id ?? null);
  const [profileOpen, setProfileOpen] = useState(false);

  const [desktopCollapsed, setDesktopCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [dialog, setDialog] = useState(null); // { type: 'clear' | 'delete' | 'deleteAll', id? }
  const [authMode, setAuthMode] = useState(null); // 'signin' | 'signup' | null
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const textareaRef = useRef(null);
  const toggleRef = useRef(null);

  const { sessions, activeSessionId, request, outcome, storageWarning, usage, limits, limit, notice, kind } = state;
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;
  const messages = activeSession?.messages ?? [];
  const isGuest = kind === 'guest';

  const sidebarOpen = isDesktop ? !desktopCollapsed : drawerOpen;
  const drawerActive = !isDesktop && drawerOpen;
  const closeDrawer = () => setDrawerOpen(false);

  // ---- guest history import (offered after signing in) --------------------
  const [importRev, setImportRev] = useState(0);
  const [importUi, setImportUi] = useState({ busy: false, error: null, progress: { done: 0, total: 0 }, carryDepth: true });
  const pendingImport = useMemo(() => {
    void importRev;
    if (!user || kind !== 'user') return [];
    const storage = safeStorage();
    const guest = loadHistory(storage).sessions;
    if (guest.length === 0) return [];
    try {
      if (storage?.getItem(skipKey(user.id)) === signatureOf(guest)) return [];
    } catch {
      /* ignore */
    }
    return guest;
  }, [user, kind, importRev]);

  const guestDepthPref = (() => {
    try {
      return localStorage.getItem('mitra-ai:depth') ?? 'balanced';
    } catch {
      return 'balanced';
    }
  })();

  const runImport = async () => {
    setImportUi((u) => ({ ...u, busy: true, error: null, progress: { done: 0, total: pendingImport.length } }));
    try {
      const cloud = createCloudStore(supabase, user.id);
      const imported = await importGuestHistory(cloud, pendingImport, {
        onProgress: (done, total) => setImportUi((u) => ({ ...u, progress: { done, total } })),
      });
      // Only after every conversation arrived: remove the imported guest copies.
      const storage = safeStorage();
      const remaining = loadHistory(storage).sessions.filter((s) => !imported.includes(s.id));
      saveHistory(storage, { sessions: remaining, activeSessionId: remaining[0]?.id ?? null });
      if (importUi.carryDepth && guestDepthPref !== 'balanced') account.setDepth(guestDepthPref);
      controller.reloadFromCloud();
      setImportUi((u) => ({ ...u, busy: false }));
      setImportRev((r) => r + 1);
    } catch {
      // Guest conversations are untouched; running it again is safe (idempotent).
      setImportUi((u) => ({ ...u, busy: false, error: "The import didn't finish. Your guest conversations are still here. You can try again." }));
    }
  };
  const skipImport = () => {
    try {
      safeStorage()?.setItem(skipKey(user.id), signatureOf(pendingImport));
    } catch {
      /* ignore */
    }
    setImportUi((u) => ({ ...u, error: null }));
    setImportRev((r) => r + 1);
  };

  // ---- sidebar / navigation ----------------------------------------------
  const toggleSidebar = () => {
    if (isDesktop) setDesktopCollapsed((c) => !c);
    else setDrawerOpen((o) => !o);
  };
  const closeSidebar = () => {
    if (isDesktop) setDesktopCollapsed(true);
    else closeDrawer();
    toggleRef.current?.focus();
  };
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

  const handleSend = (text) => {
    const ok = controller.sendMessage(text);
    if (ok) account.handleUserMessage(text);
    return ok;
  };

  const handleExport = async () => {
    if (!activeSession) return;
    const full = await controller.exportMessages(activeSession.id);
    if (full) downloadText(exportFilename(full), conversationToMarkdown(full));
  };

  // ---- auth actions --------------------------------------------------------
  const closeLimit = () => {
    if (limit?.restoredText) setDraft((d) => d || limit.restoredText);
    controller.dismissLimit();
  };
  const openAuth = (mode) => {
    closeLimit();
    setSettingsOpen(false);
    setAuthMode(mode);
  };
  const signOut = async () => {
    setSettingsOpen(false);
    setProfileOpen(false);
    setDraft('');
    try {
      await authService.signOut();
    } catch (err) {
      setAppNotice(err.message);
    }
  };
  const handleDeleteAccount = async () => {
    await deleteAccount({
      url: functionUrl('delete-account'),
      publishableKey: supabasePublishableKey,
      accessToken: auth.session?.access_token,
    });
    setSettingsOpen(false);
    setProfileOpen(false);
    await authService.signOut().catch(() => {});
    setAppNotice('Your account and its data have been deleted.');
  };

  // ---- confirmation dialogs -------------------------------------------------
  const confirmDialog = (() => {
    if (!dialog) return {};
    const where = isGuest ? 'from this browser' : 'from your account';
    if (dialog.type === 'clear') {
      return {
        title: 'Clear this conversation?',
        description: `All messages in this chat will be removed ${where}.`,
        confirmLabel: 'Clear conversation',
        run: () => controller.clearSession(),
      };
    }
    if (dialog.type === 'delete') {
      const target = sessions.find((s) => s.id === dialog.id);
      return {
        title: 'Delete this chat?',
        description: `“${target?.title ?? 'This chat'}” will be removed ${where}. This can’t be undone.`,
        confirmLabel: 'Delete chat',
        run: () => controller.deleteSession(dialog.id),
      };
    }
    return {
      title: 'Delete all chats?',
      description: `Every saved conversation will be removed ${where}. This can’t be undone. It does not affect anything the AI service may have already received.`,
      confirmLabel: 'Delete all',
      run: () => controller.deleteAll(),
    };
  })();

  const announcement = request ? ANNOUNCEMENTS[request.phase] : (ANNOUNCEMENTS[outcome] ?? '');
  const notConfigured = !auth.configured;
  const disabledReason = notConfigured
    ? 'Backend not configured. See the README.'
    : kind === null
      ? 'Loading…'
      : undefined;
  const bannerText = appNotice ?? notice?.text ?? null;

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
        isGuest={isGuest}
        loading={state.loadingSessions}
        hasMore={state.hasMoreSessions}
        onLoadMore={controller.loadMoreSessions}
        onRemoteSearch={isGuest ? undefined : controller.searchCloud}
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
            <button type="button" className="icon-btn" onClick={handleExport} disabled={messages.length === 0} aria-label="Export conversation as Markdown" title="Export conversation">
              <Icon name="download" />
            </button>
            <button type="button" className="icon-btn" onClick={() => setDialog({ type: 'clear' })} disabled={!activeSession || messages.length === 0} aria-label="Clear conversation" title="Clear conversation">
              <Icon name="eraser" />
            </button>
            {!sidebarOpen && (
              <button type="button" className="icon-btn" onClick={handleNewChat} aria-label="New chat" title="New chat">
                <Icon name="plus" />
              </button>
            )}
            <button type="button" className="icon-btn" onClick={() => setSettingsOpen(true)} aria-label="Settings" title="Settings">
              <Icon name="settings" />
            </button>
            {auth.configured && !auth.loading && (
              <AccountMenu
                user={user}
                profile={profileState.profile}
                avatarUrl={profileState.avatarUrl}
                onSignIn={() => setAuthMode('signin')}
                onProfile={() => setProfileOpen(true)}
                onSettings={() => setSettingsOpen(true)}
                onSignOut={signOut}
              />
            )}
          </div>
        </header>

        {(bannerText || notConfigured) && (
          <div className={`banner ${notConfigured ? 'is-error' : ''}`} role={notConfigured ? 'alert' : 'status'}>
            <span>
              {notConfigured
                ? `Mitra AI is not set up yet. ${configProblems.join(' ')} See the README (Environment variables).`
                : bannerText}
            </span>
            {bannerText && !notConfigured && (
              <button type="button" className="icon-btn icon-btn-sm" aria-label="Dismiss message" onClick={() => { setAppNotice(null); controller.dismissNotice(); }}>
                <Icon name="x" size={14} />
              </button>
            )}
          </div>
        )}

        <main className="chat-main">
          <ChatContainer
            key={activeSessionId ?? 'none'}
            messages={messages}
            request={request?.sessionId === activeSessionId ? request : null}
            loading={Boolean(activeSession) && !activeSession.messagesLoaded}
            hasMore={Boolean(activeSession?.hasMoreMessages)}
            onLoadOlder={controller.loadOlderMessages}
            onRetryMessage={controller.retryMessage}
            onPickSuggestion={handlePickSuggestion}
          />
          <div className="composer-extras">
            <MemoryBanner
              suggestion={account.suggestion}
              notice={account.memoryNotice}
              onAccept={account.acceptSuggestion}
              onDismiss={account.dismissSuggestion}
              onDismissNotice={account.dismissMemoryNotice}
              onUndo={account.undoSavedMemory}
              onManage={() => setSettingsOpen(true)}
            />
            <UsageBadge kind={kind} usage={usage} />
          </div>
          <InputArea
            value={draft}
            onChange={setDraft}
            onSend={handleSend}
            onStop={controller.stopGeneration}
            isGenerating={Boolean(request)}
            phase={request?.phase}
            textareaRef={textareaRef}
            maxLength={config.maxMessageChars}
            disabledReason={disabledReason}
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

      <AuthDialog
        open={authMode !== null}
        initialMode={authMode ?? 'signin'}
        onClose={() => setAuthMode(null)}
        onSignIn={(email, password) => authService.signIn(email, password)}
        onSignUp={async (email, password, displayName) => {
          const data = await authService.signUp(email, password, displayName);
          return { needsConfirmation: !data?.session };
        }}
        onForgot={(email) => authService.requestPasswordReset(email)}
      />

      <ResetPasswordDialog
        open={auth.recovery}
        onSubmit={(password) => authService.updatePassword(password)}
        onClose={auth.finishRecovery}
      />

      <LimitDialog
        limit={limit}
        limits={limits}
        onSignIn={() => openAuth('signin')}
        onRegister={() => openAuth('signup')}
        onClose={closeLimit}
      />

      <ImportDialog
        open={pendingImport.length > 0 && !auth.recovery}
        count={pendingImport.length}
        progress={importUi.progress}
        busy={importUi.busy}
        error={importUi.error}
        depth={guestDepthPref}
        carryDepth={importUi.carryDepth}
        onCarryDepth={(v) => setImportUi((u) => ({ ...u, carryDepth: v }))}
        onImport={runImport}
        onSkip={skipImport}
      />

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        user={user}
        usage={usage}
        limits={limits}
        account={account}
        theme={theme}
        onToggleTheme={toggleTheme}
        onSignIn={() => openAuth('signin')}
        onProfile={() => { setSettingsOpen(false); setProfileOpen(true); }}
        onDeleteChats={() => { setSettingsOpen(false); setDialog({ type: 'deleteAll' }); }}
        onDeleteAccount={handleDeleteAccount}
      />

      <ProfileDialog
        open={profileOpen && Boolean(user)}
        onClose={() => setProfileOpen(false)}
        user={user}
        state={profileState}
        actions={{
          saveDisplayName: profileManager.saveDisplayName,
          uploadAvatar: profileManager.uploadAvatar,
          removeAvatar: profileManager.removeAvatar,
          retry: profileManager.load,
        }}
      />

      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
};

export default App;
