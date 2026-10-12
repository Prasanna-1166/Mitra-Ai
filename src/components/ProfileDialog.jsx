import { useEffect, useId, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import Icon from './Icon';
import Modal from './Modal';
import { MAX_NAME_LENGTH, validateAvatarFile, validateDisplayName } from '../services/profileService';

const formatDate = (iso) => {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};

const ProfileDialog = ({
  open,
  onClose,
  user,
  profile,
  avatarUrl,
  onUpdateDisplayName,
  onUploadAvatar,
  onRemoveAvatar,
}) => {
  const titleId = useId();
  const fileInputRef = useRef(null);

  const initialName = profile?.display_name ?? (user?.email ? user.email.split('@')[0] : '');
  const [displayName, setDisplayName] = useState(initialName);
  const [nameError, setNameError] = useState(null);
  const [generalError, setGeneralError] = useState(null);
  const [successMessage, setSuccessMessage] = useState(null);
  const [busy, setBusy] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);

  // Sync state whenever profile or dialog open status changes
  useEffect(() => {
    if (open) {
      setDisplayName(profile?.display_name ?? (user?.email ? user.email.split('@')[0] : ''));
      setNameError(null);
      setGeneralError(null);
      setSuccessMessage(null);
      setBusy(false);
      setAvatarBusy(false);
    }
  }, [open, profile, user]);

  const hasNameChanged = displayName.trim() !== (profile?.display_name ?? '');

  const handleNameChange = (e) => {
    const val = e.target.value;
    setDisplayName(val);
    setSuccessMessage(null);
    if (nameError) setNameError(null);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    const err = validateDisplayName(displayName);
    if (err) {
      setNameError(err);
      return;
    }
    setBusy(true);
    setGeneralError(null);
    setSuccessMessage(null);
    try {
      await onUpdateDisplayName(displayName.trim());
      setSuccessMessage('Profile updated successfully.');
    } catch (saveErr) {
      setGeneralError(saveErr.message || 'Failed to update profile.');
    } finally {
      setBusy(false);
    }
  };

  const handleFileSelected = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const fileErr = validateAvatarFile(file);
    if (fileErr) {
      setGeneralError(fileErr);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    setAvatarBusy(true);
    setGeneralError(null);
    setSuccessMessage(null);
    try {
      await onUploadAvatar(file);
      setSuccessMessage('Profile photo updated.');
    } catch (uploadErr) {
      setGeneralError(uploadErr.message || 'Failed to upload image.');
    } finally {
      setAvatarBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleRemovePhoto = async () => {
    setAvatarBusy(true);
    setGeneralError(null);
    setSuccessMessage(null);
    try {
      await onRemoveAvatar();
      setSuccessMessage('Profile photo removed.');
    } catch (removeErr) {
      setGeneralError(removeErr.message || 'Failed to remove photo.');
    } finally {
      setAvatarBusy(false);
    }
  };

  const initial = (displayName.trim() || user?.email || '?').charAt(0).toUpperCase();
  const createdAtFormatted = formatDate(user?.created_at || profile?.created_at);

  return (
    <Modal open={open} onClose={onClose} labelledBy={titleId} size="md">
      {open && (
        <div className="dialog-body profile-dialog">
          <div className="dialog-header">
            <h2 id={titleId}>Profile</h2>
            <button
              type="button"
              className="icon-btn"
              onClick={onClose}
              aria-label="Close profile"
            >
              <Icon name="x" />
            </button>
          </div>

          {generalError && (
            <div className="notice is-error" role="alert">
              <Icon name="alert" size={16} />
              <span>{generalError}</span>
            </div>
          )}

          {successMessage && (
            <div className="notice is-success" role="status">
              <Icon name="check" size={16} />
              <span>{successMessage}</span>
            </div>
          )}

          <div className="profile-content">
            {/* Avatar Section */}
            <div className="profile-avatar-section">
              <div className="avatar-wrapper">
                {avatarUrl ? (
                  <img
                    src={avatarUrl}
                    alt={displayName || 'Your avatar'}
                    className="profile-avatar-img"
                  />
                ) : (
                  <div className="profile-avatar-fallback" aria-hidden="true">
                    {initial}
                  </div>
                )}
                {avatarBusy && <div className="avatar-loading-overlay">Uploading…</div>}
              </div>

              <div className="avatar-controls">
                <input
                  ref={fileInputRef}
                  type="file"
                  id="avatar-upload-input"
                  className="sr-only"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  onChange={handleFileSelected}
                  disabled={avatarBusy || busy}
                />
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={avatarBusy || busy}
                >
                  <Icon name="camera" size={14} />
                  {avatarUrl ? 'Change photo' : 'Upload photo'}
                </button>
                {avatarUrl && (
                  <button
                    type="button"
                    className="btn btn-sm btn-quiet"
                    onClick={handleRemovePhoto}
                    disabled={avatarBusy || busy}
                  >
                    Remove photo
                  </button>
                )}
                <span className="field-hint">JPG, PNG, WebP or GIF up to 2 MB.</span>
              </div>
            </div>

            {/* Profile Form */}
            <form onSubmit={handleSave} className="profile-form">
              <div className="field">
                <label htmlFor="profile-display-name">
                  Display name
                  <span className="char-count">
                    {displayName.length}/{MAX_NAME_LENGTH}
                  </span>
                </label>
                <input
                  id="profile-display-name"
                  type="text"
                  value={displayName}
                  onChange={handleNameChange}
                  maxLength={MAX_NAME_LENGTH}
                  aria-invalid={nameError ? 'true' : undefined}
                  aria-describedby={nameError ? 'display-name-error' : undefined}
                  autoComplete="name"
                  disabled={busy}
                />
                {nameError && (
                  <p className="field-error" id="display-name-error">
                    {nameError}
                  </p>
                )}
              </div>

              <div className="field">
                <label htmlFor="profile-email">Email</label>
                <input
                  id="profile-email"
                  type="email"
                  value={user?.email ?? ''}
                  readOnly
                  disabled
                  className="is-readonly"
                />
                <span className="field-hint">
                  Your email is managed by your authentication account.
                </span>
              </div>

              {/* Account Metadata */}
              <div className="profile-meta-grid">
                <div className="meta-card">
                  <span className="meta-label">
                    <Icon name="shield" size={13} /> Account status
                  </span>
                  <span className="meta-val status-badge">Active</span>
                </div>
                {createdAtFormatted && (
                  <div className="meta-card">
                    <span className="meta-label">
                      <Icon name="calendar" size={13} /> Member since
                    </span>
                    <span className="meta-val">{createdAtFormatted}</span>
                  </div>
                )}
              </div>

              <div className="dialog-actions">
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={onClose}
                  disabled={busy || avatarBusy}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-sm btn-primary"
                  disabled={!hasNameChanged || busy || avatarBusy}
                >
                  {busy ? 'Saving…' : 'Save changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </Modal>
  );
};

ProfileDialog.propTypes = {
  open: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  user: PropTypes.shape({
    id: PropTypes.string,
    email: PropTypes.string,
    created_at: PropTypes.string,
  }),
  profile: PropTypes.shape({
    id: PropTypes.string,
    display_name: PropTypes.string,
    avatar_url: PropTypes.string,
    created_at: PropTypes.string,
    updated_at: PropTypes.string,
  }),
  avatarUrl: PropTypes.string,
  onUpdateDisplayName: PropTypes.func.isRequired,
  onUploadAvatar: PropTypes.func.isRequired,
  onRemoveAvatar: PropTypes.func.isRequired,
};

export default ProfileDialog;
