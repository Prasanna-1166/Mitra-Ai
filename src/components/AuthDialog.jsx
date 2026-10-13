import { useId, useState } from 'react';
import PropTypes from 'prop-types';
import BrandMark from './BrandMark';
import Icon from './Icon';
import Modal from './Modal';
import { validateDisplayName } from '../lib/profile';
import { validateEmail, validatePassword } from '../services/authService';

const TITLES = { signin: 'Sign in', signup: 'Create your account', forgot: 'Reset your password' };

const PasswordField = ({ id, label, value, onChange, error, autoComplete, hint }) => {
  const [shown, setShown] = useState(false);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="input-wrap">
        <input
          id={id}
          type={shown ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        />
        <button
          type="button"
          className="icon-btn icon-btn-sm"
          onClick={() => setShown((s) => !s)}
          aria-label={shown ? 'Hide password' : 'Show password'}
          aria-pressed={shown}
        >
          <Icon name={shown ? 'eyeOff' : 'eye'} size={16} />
        </button>
      </div>
      {error ? <p className="field-error" id={`${id}-error`}>{error}</p> : hint ? <p className="field-hint" id={`${id}-hint`}>{hint}</p> : null}
    </div>
  );
};
PasswordField.propTypes = {
  id: PropTypes.string.isRequired, label: PropTypes.string.isRequired, value: PropTypes.string.isRequired,
  onChange: PropTypes.func.isRequired, error: PropTypes.string, autoComplete: PropTypes.string, hint: PropTypes.string,
};

const AuthForm = ({ initialMode, onClose, onSignIn, onSignUp, onForgot }) => {
  const uid = useId();
  const [mode, setMode] = useState(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null); // 'confirm' | 'reset-sent'

  const switchMode = (next) => {
    setMode(next);
    setErrors({});
    setFormError(null);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    const next = {};
    const emailError = validateEmail(email);
    if (emailError) next.email = emailError;
    if (mode === 'signup') {
      const pw = validatePassword(password);
      if (pw) next.password = pw;
      const nm = validateDisplayName(displayName);
      if (!nm.ok) next.displayName = nm.error;
    } else if (mode === 'signin' && !password) next.password = 'Enter your password.';
    setErrors(next);
    setFormError(null);
    if (Object.keys(next).length > 0) return;

    setBusy(true);
    try {
      if (mode === 'signin') {
        await onSignIn(email, password);
        onClose();
      } else if (mode === 'signup') {
        const result = await onSignUp(email, password, validateDisplayName(displayName).value);
        if (result?.needsConfirmation) setDone('confirm');
        else onClose();
      } else {
        await onForgot(email);
        setDone('reset-sent');
      }
    } catch (err) {
      setFormError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const titleId = `${uid}-title`;
  if (done) {
    return (
      <div className="dialog-body" role="document">
        <h2 id={titleId}>{done === 'confirm' ? 'Check your email' : 'Reset link sent'}</h2>
        <p role="status">
          {done === 'confirm'
            ? `We sent a confirmation link to ${email.trim()}. Open it to activate your account, then sign in.`
            : 'If an account exists for that email, a password reset link is on its way. It may take a minute to arrive.'}
        </p>
        <div className="dialog-actions">
          <button type="button" className="btn btn-primary" onClick={() => { setDone(null); switchMode('signin'); }}>
            Back to sign in
          </button>
        </div>
      </div>
    );
  }

  return (
    <form className="dialog-body auth-form" onSubmit={submit} noValidate aria-labelledby={titleId}>
      <div className="auth-brand"><BrandMark /><span>Mitra AI</span></div>
      <h2 id={titleId}>{TITLES[mode]}</h2>
      {mode === 'forgot' && <p className="dialog-lead">Enter your email and we&apos;ll send you a link to choose a new password.</p>}
      {mode === 'signup' && <p className="dialog-lead">Save your chats to the cloud, use them on any device, and get a higher daily allowance.</p>}

      <div className="field">
        <label htmlFor={`${uid}-email`}>Email</label>
        <input
          id={`${uid}-email`} type="email" value={email} autoComplete="email" autoFocus
          onChange={(e) => setEmail(e.target.value)}
          aria-invalid={errors.email ? 'true' : undefined}
          aria-describedby={errors.email ? `${uid}-email-error` : undefined}
        />
        {errors.email && <p className="field-error" id={`${uid}-email-error`}>{errors.email}</p>}
      </div>

      {mode === 'signup' && (
        <div className="field">
          <label htmlFor={`${uid}-name`}>Display name <span className="field-optional">(optional)</span></label>
          <input
            id={`${uid}-name`} value={displayName} autoComplete="nickname" maxLength={70}
            onChange={(e) => setDisplayName(e.target.value)}
            aria-invalid={errors.displayName ? 'true' : undefined}
            aria-describedby={errors.displayName ? `${uid}-name-error` : undefined}
          />
          {errors.displayName && <p className="field-error" id={`${uid}-name-error`}>{errors.displayName}</p>}
        </div>
      )}

      {mode !== 'forgot' && (
        <PasswordField
          id={`${uid}-password`} label="Password" value={password} onChange={setPassword} error={errors.password}
          autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
          hint={mode === 'signup' ? 'At least 8 characters, with letters and numbers.' : undefined}
        />
      )}

      {formError && <p className="notice is-error" role="alert"><Icon name="alert" size={16} /><span>{formError}</span></p>}

      <button type="submit" className="btn btn-primary btn-wide" disabled={busy}>
        {busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Send reset link'}
      </button>

      <div className="auth-links">
        {mode === 'signin' && (
          <>
            <button type="button" className="link-btn" onClick={() => switchMode('forgot')}>Forgot password?</button>
            <button type="button" className="link-btn" onClick={() => switchMode('signup')}>Create an account</button>
          </>
        )}
        {mode === 'signup' && <button type="button" className="link-btn" onClick={() => switchMode('signin')}>Already have an account? Sign in</button>}
        {mode === 'forgot' && <button type="button" className="link-btn" onClick={() => switchMode('signin')}>Back to sign in</button>}
      </div>
      <button type="button" className="icon-btn dialog-close" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
    </form>
  );
};
AuthForm.propTypes = {
  initialMode: PropTypes.string.isRequired, onClose: PropTypes.func.isRequired,
  onSignIn: PropTypes.func.isRequired, onSignUp: PropTypes.func.isRequired, onForgot: PropTypes.func.isRequired,
};

const AuthDialog = ({ open, initialMode = 'signin', onClose, onSignIn, onSignUp, onForgot }) => (
  <Modal open={open} onClose={onClose} size="sm">
    <AuthForm initialMode={initialMode} onClose={onClose} onSignIn={onSignIn} onSignUp={onSignUp} onForgot={onForgot} />
  </Modal>
);
AuthDialog.propTypes = {
  open: PropTypes.bool.isRequired, initialMode: PropTypes.oneOf(['signin', 'signup', 'forgot']),
  onClose: PropTypes.func.isRequired, onSignIn: PropTypes.func.isRequired,
  onSignUp: PropTypes.func.isRequired, onForgot: PropTypes.func.isRequired,
};
export default AuthDialog;

// Shown after following a password-reset email link.
const ResetForm = ({ onSubmit, onClose }) => {
  const uid = useId();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    const next = {};
    const pw = validatePassword(password);
    if (pw) next.password = pw;
    if (confirm !== password) next.confirm = 'The passwords do not match.';
    setErrors(next);
    setFormError(null);
    if (Object.keys(next).length) return;
    setBusy(true);
    try {
      await onSubmit(password);
      setDone(true);
    } catch (err) {
      setFormError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="dialog-body">
        <h2 id={`${uid}-title`}>Password updated</h2>
        <p role="status">Your password has been changed and you are signed in.</p>
        <div className="dialog-actions"><button type="button" className="btn btn-primary" onClick={onClose}>Continue</button></div>
      </div>
    );
  }
  return (
    <form className="dialog-body auth-form" onSubmit={submit} noValidate aria-labelledby={`${uid}-title`}>
      <h2 id={`${uid}-title`}>Choose a new password</h2>
      <PasswordField id={`${uid}-new`} label="New password" value={password} onChange={setPassword} error={errors.password} autoComplete="new-password" hint="At least 8 characters, with letters and numbers." />
      <PasswordField id={`${uid}-confirm`} label="Confirm new password" value={confirm} onChange={setConfirm} error={errors.confirm} autoComplete="new-password" />
      {formError && <p className="notice is-error" role="alert"><Icon name="alert" size={16} /><span>{formError}</span></p>}
      <button type="submit" className="btn btn-primary btn-wide" disabled={busy}>{busy ? 'Please wait…' : 'Update password'}</button>
    </form>
  );
};
ResetForm.propTypes = { onSubmit: PropTypes.func.isRequired, onClose: PropTypes.func.isRequired };

export const ResetPasswordDialog = ({ open, onSubmit, onClose }) => (
  <Modal open={open} onClose={onClose} size="sm">
    <ResetForm onSubmit={onSubmit} onClose={onClose} />
  </Modal>
);
ResetPasswordDialog.propTypes = { open: PropTypes.bool.isRequired, onSubmit: PropTypes.func.isRequired, onClose: PropTypes.func.isRequired };
