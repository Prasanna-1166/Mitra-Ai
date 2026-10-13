import { useId } from 'react';
import PropTypes from 'prop-types';
import Modal from './Modal';

const resetText = (resetsAt) => {
  const t = Date.parse(resetsAt);
  if (Number.isNaN(t)) return 'tomorrow (UTC)';
  return new Date(t).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
};

// Shown when the server refuses a question because the allowance is used up.
const LimitDialog = ({ limit, limits, onSignIn, onRegister, onClose }) => {
  const id = useId();
  const open = Boolean(limit);
  const isGuest = limit?.kind === 'guest';
  return (
    <Modal open={open} onClose={onClose} labelledBy={id} size="sm" role="alertdialog">
      {open && (
        <div className="dialog-body">
          <h2 id={id}>{isGuest ? "You've used your free questions" : "You've reached today's limit"}</h2>
          {isGuest ? (
            <>
              <p>
                Guests can ask {limits?.guest ?? limit.usage?.limit ?? 'a few'} questions without an account.
                {limits?.user ? ` A free account unlocks ${limits.user} questions per day` : ' A free account unlocks a higher daily allowance'} and saves your
                conversations to the cloud so you can pick them up on any device.
              </p>
              <p className="dialog-note">Your current conversation stays here. Nothing is deleted.</p>
            </>
          ) : (
            <p>
              You&apos;ve used all {limit.usage?.limit ?? ''} questions for today. Your allowance resets at {resetText(limit.usage?.resetsAt)}.
              Your conversations are untouched.
            </p>
          )}
          <div className="dialog-actions dialog-actions-stack">
            {isGuest && (
              <>
                <button type="button" className="btn btn-primary" onClick={onRegister}>Create account</button>
                <button type="button" className="btn" onClick={onSignIn}>Sign in</button>
              </>
            )}
            <button type="button" className="btn btn-quiet" onClick={onClose} autoFocus={!isGuest}>
              {isGuest ? 'Back to my conversation' : 'Close'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
};
LimitDialog.propTypes = {
  limit: PropTypes.shape({ kind: PropTypes.string, usage: PropTypes.object }),
  limits: PropTypes.shape({ guest: PropTypes.number, user: PropTypes.number }),
  onSignIn: PropTypes.func.isRequired, onRegister: PropTypes.func.isRequired, onClose: PropTypes.func.isRequired,
};
export default LimitDialog;
