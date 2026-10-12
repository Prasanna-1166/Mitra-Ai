import { useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import Icon from './Icon';

// Guests see "Sign in"; signed-in users get a menu for Profile, Settings, and Sign out.
const AccountMenu = ({ user, profile, avatarUrl, onOpenProfile, onSignIn, onSettings, onSignOut }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!user) {
    return (
      <button type="button" className="btn btn-sm" onClick={onSignIn}>Sign in</button>
    );
  }

  const displayName = profile?.display_name?.trim() || '';
  const initialSource = displayName || user.email || '?';
  const initial = initialSource.trim().charAt(0).toUpperCase();

  return (
    <div className="account-menu" ref={ref}>
      <button
        type="button"
        className="avatar-btn"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account menu for ${user.email}`}
      >
        {avatarUrl ? (
          <img src={avatarUrl} alt="" className="avatar-img" />
        ) : (
          initial
        )}
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-header">
            {displayName && <strong className="menu-name" title={displayName}>{displayName}</strong>}
            <p className="menu-email" title={user.email}>{user.email}</p>
          </div>
          {onOpenProfile && (
            <button
              type="button"
              role="menuitem"
              className="menu-item"
              onClick={() => {
                setOpen(false);
                onOpenProfile();
              }}
            >
              <Icon name="user" size={16} />Profile
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => {
              setOpen(false);
              onSettings();
            }}
          >
            <Icon name="settings" size={16} />Settings
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu-item menu-item-danger"
            onClick={() => {
              setOpen(false);
              onSignOut();
            }}
          >
            <Icon name="logout" size={16} />Sign out
          </button>
        </div>
      )}
    </div>
  );
};

AccountMenu.propTypes = {
  user: PropTypes.shape({ email: PropTypes.string }),
  profile: PropTypes.shape({ display_name: PropTypes.string, avatar_url: PropTypes.string }),
  avatarUrl: PropTypes.string,
  onOpenProfile: PropTypes.func,
  onSignIn: PropTypes.func.isRequired,
  onSettings: PropTypes.func.isRequired,
  onSignOut: PropTypes.func.isRequired,
};

export default AccountMenu;
