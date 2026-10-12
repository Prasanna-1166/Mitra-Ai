import { useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import Icon from './Icon';

// Guests see "Sign in"; signed-in users get a small menu.
const AccountMenu = ({ user, onSignIn, onSettings, onSignOut }) => {
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
  const initial = (user.email ?? '?').trim().charAt(0).toUpperCase();
  return (
    <div className="account-menu" ref={ref}>
      <button
        type="button" className="avatar-btn" onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu" aria-expanded={open} aria-label={`Account menu for ${user.email}`}
      >
        {initial}
      </button>
      {open && (
        <div className="menu" role="menu">
          <p className="menu-email" title={user.email}>{user.email}</p>
          <button type="button" role="menuitem" className="menu-item" onClick={() => { setOpen(false); onSettings(); }}>
            <Icon name="settings" size={16} />Settings
          </button>
          <button type="button" role="menuitem" className="menu-item" onClick={() => { setOpen(false); onSignOut(); }}>
            <Icon name="logout" size={16} />Sign out
          </button>
        </div>
      )}
    </div>
  );
};
AccountMenu.propTypes = {
  user: PropTypes.shape({ email: PropTypes.string }),
  onSignIn: PropTypes.func.isRequired, onSettings: PropTypes.func.isRequired, onSignOut: PropTypes.func.isRequired,
};
export default AccountMenu;
