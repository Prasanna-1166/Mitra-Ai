import { useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import Avatar from './Avatar';
import Icon from './Icon';
import { displayNameOf } from '../lib/profile';

// Guests see "Sign in"; signed-in users get a menu: Profile, Settings, Sign out.
// Keyboard: Enter/Space/ArrowDown opens, arrows move, Escape closes and returns focus.
const AccountMenu = ({ user, profile, avatarUrl, onSignIn, onProfile, onSettings, onSignOut }) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const buttonRef = useRef(null);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    menuRef.current?.querySelector('[role="menuitem"]')?.focus();
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (!user) return <button type="button" className="btn btn-sm" onClick={onSignIn}>Sign in</button>;

  const name = displayNameOf(profile, user);
  const close = (returnFocus = true) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  };
  const onMenuKey = (e) => {
    const items = [...menuRef.current.querySelectorAll('[role="menuitem"]')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(i + 1) % items.length].focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length].focus();
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };
  const choose = (fn) => () => {
    close(false);
    fn();
  };

  return (
    <div className="account-menu" ref={rootRef}>
      <button
        ref={buttonRef} type="button" className="avatar-btn" onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu" aria-expanded={open} aria-label={`Account menu for ${name}`}
      >
        <Avatar name={name} url={avatarUrl} size={30} />
      </button>
      {open && (
        <div className="menu" role="menu" ref={menuRef} onKeyDown={onMenuKey}>
          <div className="menu-head">
            <Avatar name={name} url={avatarUrl} size={36} />
            <div className="menu-id">
              <strong title={name}>{name}</strong>
              <span title={user.email}>{user.email}</span>
            </div>
          </div>
          <button type="button" role="menuitem" className="menu-item" onClick={choose(onProfile)}><Icon name="user" size={16} />Profile</button>
          <button type="button" role="menuitem" className="menu-item" onClick={choose(onSettings)}><Icon name="settings" size={16} />Settings</button>
          <button type="button" role="menuitem" className="menu-item" onClick={choose(onSignOut)}><Icon name="logout" size={16} />Sign out</button>
        </div>
      )}
    </div>
  );
};
AccountMenu.propTypes = {
  user: PropTypes.shape({ email: PropTypes.string }),
  profile: PropTypes.shape({ displayName: PropTypes.string }),
  avatarUrl: PropTypes.string,
  onSignIn: PropTypes.func.isRequired, onProfile: PropTypes.func.isRequired,
  onSettings: PropTypes.func.isRequired, onSignOut: PropTypes.func.isRequired,
};
export default AccountMenu;
