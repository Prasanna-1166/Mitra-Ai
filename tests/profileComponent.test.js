import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadModule } from './helpers.js';

let ProfileDialog, AccountMenu;
const noop = () => {};

before(async () => {
  ProfileDialog = (await loadModule('src/components/ProfileDialog.jsx')).default;
  AccountMenu = (await loadModule('src/components/AccountMenu.jsx')).default;
});

test('profile dialog: renders profile details, email, member date, and fallback avatar', () => {
  const user = {
    id: 'user-1',
    email: 'charlie@example.com',
    created_at: '2026-01-15T12:00:00.000Z',
  };
  const profile = {
    id: 'user-1',
    display_name: 'Charlie Brown',
    avatar_url: null,
    created_at: '2026-01-15T12:00:00.000Z',
  };

  const html = renderToStaticMarkup(
    h(ProfileDialog, {
      open: true,
      onClose: noop,
      user,
      profile,
      avatarUrl: null,
      onUpdateDisplayName: noop,
      onUploadAvatar: noop,
      onRemoveAvatar: noop,
    }),
  );

  assert.match(html, /<h2[^>]*>Profile<\/h2>/);
  assert.match(html, /value="Charlie Brown"/);
  assert.match(html, /value="charlie@example\.com"/);
  assert.match(html, /class="profile-avatar-fallback"[^>]*>C<\/div>/);
  assert.match(html, /Upload photo/);
  assert.match(html, />Active<\/span>/);
  assert.match(html, /Member since/);
  assert.match(html, /15 Jan 2026|Jan 15, 2026/);
  assert.match(html, />Save changes<\/button>/);
});

test('profile dialog: renders custom avatar image and remove button when avatar is set', () => {
  const user = { id: 'user-1', email: 'charlie@example.com' };
  const profile = { id: 'user-1', display_name: 'Charlie', avatar_url: 'user-1/avatar.png' };
  const avatarUrl = 'https://example.com/signed-avatar.png';

  const html = renderToStaticMarkup(
    h(ProfileDialog, {
      open: true,
      onClose: noop,
      user,
      profile,
      avatarUrl,
      onUpdateDisplayName: noop,
      onUploadAvatar: noop,
      onRemoveAvatar: noop,
    }),
  );

  assert.match(html, /<img[^>]*src="https:\/\/example\.com\/signed-avatar\.png"/);
  assert.match(html, /Change photo/);
  assert.match(html, />Remove photo<\/button>/);
});

test('account menu: shows avatar image and Profile menuItem when authenticated with avatar', () => {
  const user = { email: 'charlie@example.com' };
  const profile = { display_name: 'Charlie Brown', avatar_url: 'user-1/avatar.png' };
  const avatarUrl = 'https://example.com/avatar.jpg';

  const html = renderToStaticMarkup(
    h(AccountMenu, {
      user,
      profile,
      avatarUrl,
      onOpenProfile: noop,
      onSignIn: noop,
      onSettings: noop,
      onSignOut: noop,
    }),
  );

  assert.match(html, /aria-label="Account menu for charlie@example\.com"/);
  assert.match(html, /<img[^>]*src="https:\/\/example\.com\/avatar\.jpg"/);
});
