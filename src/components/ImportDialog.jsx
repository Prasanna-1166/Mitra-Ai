import { useId } from 'react';
import PropTypes from 'prop-types';
import Modal from './Modal';

const ImportDialog = ({ open, count, progress, busy, error, depth, carryDepth, onCarryDepth, onImport, onSkip }) => {
  const id = useId();
  return (
    <Modal open={open} onClose={busy ? () => {} : onSkip} labelledBy={id} size="sm">
      {open && (
        <div className="dialog-body">
          <h2 id={id}>Save your guest conversations to your account?</h2>
          <p>
            You have {count} conversation{count === 1 ? '' : 's'} saved in this browser. Import {count === 1 ? 'it' : 'them'} to
            keep {count === 1 ? 'it' : 'them'} in your account, available on every device. Imported chats are removed from this browser
            once the import succeeds. Skip to leave them here untouched.
          </p>
          {depth && depth !== 'balanced' && (
            <label className="check-row">
              <input type="checkbox" checked={carryDepth} onChange={(e) => onCarryDepth(e.target.checked)} disabled={busy} />
              Also use my {depth} response style in my account
            </label>
          )}
          {busy && (
            <div role="status" aria-live="polite">
              <progress className="progress" max={progress.total || 1} value={progress.done} aria-label="Import progress" />
              <p className="dialog-note">Importing {progress.done} of {progress.total}…</p>
            </div>
          )}
          {error && <p className="notice is-error" role="alert"><span>{error}</span></p>}
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={onSkip} disabled={busy}>Skip</button>
            <button type="button" className="btn btn-primary" onClick={onImport} disabled={busy} autoFocus>
              {error ? 'Try again' : busy ? 'Importing…' : 'Import'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
};
ImportDialog.propTypes = {
  open: PropTypes.bool.isRequired, count: PropTypes.number.isRequired,
  progress: PropTypes.shape({ done: PropTypes.number, total: PropTypes.number }).isRequired,
  busy: PropTypes.bool, error: PropTypes.string, depth: PropTypes.string, carryDepth: PropTypes.bool, onCarryDepth: PropTypes.func, onImport: PropTypes.func.isRequired, onSkip: PropTypes.func.isRequired,
};
export default ImportDialog;
