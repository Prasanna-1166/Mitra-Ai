import { useId, useState } from 'react';
import PropTypes from 'prop-types';
import Icon from './Icon';
import MemoryPanel from './MemoryPanel';
import Modal from './Modal';

const DEPTH_OPTIONS = [
  ['concise', 'Concise', 'The key answer with minimal detail.'],
  ['balanced', 'Balanced', 'A useful explanation with the necessary context.'],
  ['detailed', 'Detailed', 'In-depth explanations, examples, steps and caveats.'],
];

const formatReset = (iso) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
};

const DeleteAccount = ({ onDelete }) => {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const id = useId();
  if (!open) {
    return <button type="button" className="btn btn-sm btn-danger-outline" onClick={() => setOpen(true)}>Delete account…</button>;
  }
  return (
    <form
      className="danger-zone"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await onDelete();
        } catch (err) {
          setError(err.message);
          setBusy(false);
        }
      }}
    >
      <p>
        This permanently deletes your account, all saved conversations, memories and usage records. It cannot be undone.
        Type <strong>DELETE</strong> to confirm.
      </p>
      <label htmlFor={id} className="sr-only">Type DELETE to confirm</label>
      <input id={id} value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" autoFocus />
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="btn btn-sm" onClick={() => { setOpen(false); setText(''); }} disabled={busy}>Cancel</button>
        <button type="submit" className="btn btn-sm btn-danger" disabled={text !== 'DELETE' || busy}>{busy ? 'Deleting…' : 'Delete my account'}</button>
      </div>
    </form>
  );
};
DeleteAccount.propTypes = { onDelete: PropTypes.func.isRequired };

const SettingsDialog = ({ open, onClose, user, usage, limits, account, theme, onToggleTheme, onSignIn, onProfile, onDeleteChats, onDeleteAccount }) => {
  const titleId = useId();
  return (
    <Modal open={open} onClose={onClose} labelledBy={titleId} size="lg">
      {open && (
        <div className="dialog-body settings">
          <div className="settings-head">
            <h2 id={titleId}>Settings</h2>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close settings"><Icon name="x" /></button>
          </div>

          <section aria-labelledby={`${titleId}-account`}>
            <h3 id={`${titleId}-account`}>Account</h3>
            {user ? (
              <>
                <p className="settings-row"><span>Signed in as</span><strong>{user.email}</strong></p>
                {usage && (
                  <p className="settings-row">
                    <span>Today&apos;s questions</span>
                    <strong>{usage.used} of {usage.limit} used{formatReset(usage.resetsAt) ? ` · resets ${formatReset(usage.resetsAt)}` : ''}</strong>
                  </p>
                )}
                <button type="button" className="btn btn-sm" onClick={onProfile}><Icon name="user" size={14} />Edit profile</button>
              </>
            ) : (
              <>
                <p className="field-hint">
                  You&apos;re using Mitra AI as a guest
                  {usage ? `: ${usage.remaining} of ${usage.limit} free questions left` : ''}. An account saves chats to the cloud, adds memory
                  {limits?.user ? ` and raises the limit to ${limits.user} questions per day` : ' and raises the daily limit'}.
                </p>
                <div className="row-actions">
                  <button type="button" className="btn btn-sm btn-primary" onClick={onSignIn}>Sign in or create account</button>
                </div>
              </>
            )}
          </section>

          <section aria-labelledby={`${titleId}-theme`}>
            <h3 id={`${titleId}-theme`}>Appearance</h3>
            <button type="button" className="btn btn-sm" onClick={onToggleTheme}>
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={14} />
              {theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            </button>
          </section>

          <section aria-labelledby={`${titleId}-depth`}>
            <h3 id={`${titleId}-depth`}>Response style</h3>
            <div role="radiogroup" aria-labelledby={`${titleId}-depth`} className="seg">
              {DEPTH_OPTIONS.map(([value, label, hint]) => (
                <label key={value} className={`seg-option ${account.depth === value ? 'is-selected' : ''}`}>
                  <input type="radio" name="depth" value={value} checked={account.depth === value} onChange={() => account.setDepth(value)} />
                  <span className="seg-label">{label}</span>
                  <span className="seg-hint">{hint}</span>
                </label>
              ))}
            </div>
            <p className="field-hint">
              This changes how Mitra AI is instructed to answer. The underlying AI model comes from an external provider and is not changed by it.
              {!user && ' Your choice is kept in this browser.'}
            </p>
          </section>

          <section aria-labelledby={`${titleId}-memory`}>
            <h3 id={`${titleId}-memory`}>Memory</h3>
            {user ? (
              <MemoryPanel
                settings={account.settings} memories={account.memories} error={account.error}
                onMemoryEnabled={account.setMemoryEnabled} onAutoMemory={account.setAutoMemory}
                onAdd={account.addMemory} onUpdate={account.updateMemory} onRemove={account.removeMemory} onClearAll={account.clearMemories}
              />
            ) : (
              <p className="field-hint">Memory is available with an account. Guest conversations don&apos;t share notes between chats.</p>
            )}
          </section>

          <section aria-labelledby={`${titleId}-data`}>
            <h3 id={`${titleId}-data`}>Your data</h3>
            <p className="field-hint">
              {user
                ? 'Conversations, memories and settings are stored in your account in the cloud.'
                : 'Guest conversations are stored only in this browser. They are not synced to other devices.'}
              {' '}Your questions are sent to an external AI service to generate answers.
            </p>
            <div className="row-actions">
              <button type="button" className="btn btn-sm" onClick={onDeleteChats}><Icon name="trash" size={14} />Delete all chats</button>
              {user && <DeleteAccount onDelete={onDeleteAccount} />}
            </div>
          </section>
        </div>
      )}
    </Modal>
  );
};

SettingsDialog.propTypes = {
  open: PropTypes.bool.isRequired, onClose: PropTypes.func.isRequired,
  user: PropTypes.shape({ email: PropTypes.string }), usage: PropTypes.object, limits: PropTypes.object,
  account: PropTypes.object.isRequired,
  theme: PropTypes.string, onToggleTheme: PropTypes.func.isRequired,
  onSignIn: PropTypes.func.isRequired, onProfile: PropTypes.func.isRequired,
  onDeleteChats: PropTypes.func.isRequired, onDeleteAccount: PropTypes.func.isRequired,
};
export default SettingsDialog;
