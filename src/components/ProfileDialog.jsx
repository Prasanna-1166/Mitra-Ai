import { useId, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import Avatar from './Avatar';
import Icon from './Icon';
import Modal from './Modal';
import { AVATAR_TYPES, DISPLAY_NAME_MAX, defaultDisplayName, validateDisplayName } from '../lib/profile';

const formatDate = (iso) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
};

const ProfileForm = ({ user, state, actions, onClose }) => {
  const uid = useId();
  const fileRef = useRef(null);
  const { profile, status, avatarUrl, saving, error } = state;
  const [name, setName] = useState(profile?.displayName ?? '');
  const [nameError, setNameError] = useState(null);
  const [message, setMessage] = useState(null); // { kind: 'ok' | 'error', text }

  const fallbackName = defaultDisplayName(user?.email);
  const shownName = validateDisplayName(name).value ?? fallbackName;
  const dirty = (validateDisplayName(name).value ?? null) !== (profile?.displayName ?? null);

  const save = async (e) => {
    e.preventDefault();
    if (saving || !dirty) return;
    const checked = validateDisplayName(name);
    if (!checked.ok) {
      setNameError(checked.error);
      return;
    }
    setNameError(null);
    setMessage(null);
    const result = await actions.saveDisplayName(name);
    if (result.ok) setMessage({ kind: 'ok', text: 'Profile saved.' });
    else setMessage({ kind: 'error', text: result.error });
  };

  const pickFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow choosing the same file again
    if (!file) return;
    setMessage(null);
    const result = await actions.uploadAvatar(file);
    setMessage(result.ok ? { kind: 'ok', text: 'Photo updated.' } : { kind: 'error', text: result.error });
  };

  const removePhoto = async () => {
    setMessage(null);
    const result = await actions.removeAvatar();
    setMessage(result.ok ? { kind: 'ok', text: 'Photo removed.' } : { kind: 'error', text: result.error });
  };

  const created = formatDate(user?.created_at);
  const confirmed = user?.email_confirmed_at ? formatDate(user.email_confirmed_at) : null;

  return (
    <div className="dialog-body profile">
      <div className="settings-head">
        <h2 id={`${uid}-title`}>Profile</h2>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close profile"><Icon name="x" /></button>
      </div>

      {status === 'loading' && <p role="status" className="field-hint">Loading your profile…</p>}
      {status === 'error' && (
        <div className="notice is-error" role="alert">
          <Icon name="alert" size={16} />
          <div className="notice-text"><strong>Profile unavailable</strong><span>{error}</span></div>
          <button type="button" className="btn btn-sm" onClick={actions.retry}><Icon name="retry" size={14} />Retry</button>
        </div>
      )}

      {status === 'ready' && (
        <form onSubmit={save} noValidate aria-labelledby={`${uid}-title`} className="profile-form">
          <div className="profile-photo">
            <Avatar name={shownName} url={avatarUrl} size={72} />
            <div className="profile-photo-actions">
              <div className="row-actions">
                <button type="button" className="btn btn-sm" onClick={() => fileRef.current?.click()} disabled={saving}>
                  {profile?.avatarPath ? 'Change photo' : 'Upload photo'}
                </button>
                {profile?.avatarPath && (
                  <button type="button" className="btn btn-sm btn-quiet" onClick={removePhoto} disabled={saving}>Remove photo</button>
                )}
              </div>
              <p className="field-hint">PNG, JPEG or WebP up to 5 MB. Photos are resized, stored privately, and saved as soon as you choose them.</p>
              <input ref={fileRef} type="file" className="sr-only" tabIndex={-1} accept={AVATAR_TYPES.join(',')} onChange={pickFile} aria-label="Choose a profile photo" />
            </div>
          </div>

          <div className="field">
            <label htmlFor={`${uid}-name`}>Display name</label>
            <input
              id={`${uid}-name`} value={name} maxLength={DISPLAY_NAME_MAX + 20} autoComplete="nickname"
              onChange={(e) => { setName(e.target.value); setNameError(null); setMessage(null); }}
              aria-invalid={nameError ? 'true' : undefined}
              aria-describedby={`${uid}-name-hint`}
            />
            <p className={nameError ? 'field-error' : 'field-hint'} id={`${uid}-name-hint`}>
              {nameError ?? `Shown in your account menu. Leave blank to use “${fallbackName}”.`}
            </p>
          </div>

          <dl className="profile-meta">
            <div><dt>Email</dt><dd>{user?.email}</dd></div>
            <div><dt>Email status</dt><dd>{confirmed ? `Confirmed ${confirmed}` : user?.email_confirmed_at ? 'Confirmed' : 'Not confirmed'}</dd></div>
            {created && <div><dt>Member since</dt><dd>{created}</dd></div>}
          </dl>

          {message && (
            <p className={message.kind === 'error' ? 'notice is-error' : 'field-ok'} role={message.kind === 'error' ? 'alert' : 'status'}>
              {message.kind === 'error' && <Icon name="alert" size={16} />}<span>{message.text}</span>
            </p>
          )}

          <div className="dialog-actions">
            <button type="button" className="btn" onClick={onClose}>{dirty ? 'Cancel' : 'Close'}</button>
            <button type="submit" className="btn btn-primary" disabled={!dirty || saving}>{saving ? 'Saving…' : 'Save changes'}</button>
          </div>
        </form>
      )}
    </div>
  );
};
ProfileForm.propTypes = {
  user: PropTypes.object, state: PropTypes.object.isRequired, actions: PropTypes.object.isRequired, onClose: PropTypes.func.isRequired,
};

// Children mount only while open, so closing (or Cancel) discards unsaved edits.
const ProfileDialog = ({ open, onClose, user, state, actions }) => (
  <Modal open={open} onClose={onClose} size="md">
    <ProfileForm key={state.ownerId ?? 'none'} user={user} state={state} actions={actions} onClose={onClose} />
  </Modal>
);
ProfileDialog.propTypes = {
  open: PropTypes.bool.isRequired, onClose: PropTypes.func.isRequired, user: PropTypes.object,
  state: PropTypes.object.isRequired, actions: PropTypes.object.isRequired,
};
export default ProfileDialog;
