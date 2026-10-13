import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadModule } from './helpers.js';

let MessageBubble, InputArea, Sidebar, ChatContainer, ConfirmDialog, AuthMod, LimitDialog, ImportDialog, SettingsDialog, MemoryPanel, UsageBadge, MemoryBanner, AccountMenu, ProfileDialog, Avatar;
before(async () => {
  MessageBubble = (await loadModule('src/components/MessageBubble.jsx')).default;
  InputArea = (await loadModule('src/components/InputArea.jsx')).default;
  Sidebar = (await loadModule('src/components/Sidebar.jsx')).default;
  ChatContainer = (await loadModule('src/components/ChatContainer.jsx')).default;
  ConfirmDialog = (await loadModule('src/components/ConfirmDialog.jsx')).default;
  AuthMod = await loadModule('src/components/AuthDialog.jsx');
  LimitDialog = (await loadModule('src/components/LimitDialog.jsx')).default;
  ImportDialog = (await loadModule('src/components/ImportDialog.jsx')).default;
  SettingsDialog = (await loadModule('src/components/SettingsDialog.jsx')).default;
  MemoryPanel = (await loadModule('src/components/MemoryPanel.jsx')).default;
  UsageBadge = (await loadModule('src/components/UsageBadge.jsx')).default;
  MemoryBanner = (await loadModule('src/components/MemoryBanner.jsx')).default;
  AccountMenu = (await loadModule('src/components/AccountMenu.jsx')).default;
  ProfileDialog = (await loadModule('src/components/ProfileDialog.jsx')).default;
  Avatar = (await loadModule('src/components/Avatar.jsx')).default;
});

const assistant = (content, extra = {}) =>
  renderToStaticMarkup(
    h(MessageBubble, { message: { id: '1', role: 'assistant', content, status: 'complete', ...extra } }),
  );

test('inline code stays inline; fenced code gets a block with a language label and copy button', () => {
  const html = assistant('Use `npm run dev` now.\n\n```js\nconst a = 1;\n```');
  assert.match(html, /<p>Use <code>npm run dev<\/code> now\.<\/p>/);
  assert.equal(html.match(/class="code-block"/g).length, 1);
  assert.match(html, /<span class="code-language">js<\/span>/);
  assert.match(html, /aria-label="Copy js code"/);
  assert.match(html, /<pre[^>]*tabindex="0"[^>]*><code class="language-js">const a = 1;<\/code><\/pre>/);
  // inline code is not wrapped in a block
  assert.ok(!/code-block[^]*npm run dev/.test(html.split('const a')[0]));
});

test('fenced code without a language still gets a block', () => {
  const html = assistant('```\nplain\n```');
  assert.match(html, /class="code-block"/);
  assert.match(html, /<span class="code-language">text<\/span>/);
});

test('long single-line code and long URLs render without being altered or truncated', () => {
  const long = 'x'.repeat(5000);
  const url = 'https://example.com/' + 'a'.repeat(300);
  const html = assistant('```\n' + long + '\n```\n\n' + url);
  assert.ok(html.includes(long));
  assert.ok(html.includes(url));
});

test('links open safely in a new tab', () => {
  const html = assistant('[docs](https://example.com)');
  assert.match(html, /<a href="https:\/\/example\.com" target="_blank" rel="noopener noreferrer">docs<\/a>/);
});

test('raw HTML and javascript: links are not rendered as live markup', () => {
  const html = assistant('<img src=x onerror=alert(1)> <script>alert(1)</script> [x](javascript:alert(1))');
  assert.ok(!/<img/.test(html));
  assert.ok(!/<script/.test(html));
  assert.ok(!/href="javascript:/.test(html));
});

test('nested lists render as nested lists', () => {
  const html = assistant('- a\n  - b\n    - c\n- d');
  assert.equal(html.match(/<ul>/g).length, 3);
});

test('an unclosed code fence (mid-stream) does not break rendering', () => {
  const html = assistant('Here:\n\n```python\nprint("hi")', { status: 'streaming' });
  assert.match(html, /code-block/);
  assert.match(html, /aria-busy="true"/);
  assert.ok(!/message-actions/.test(html), 'no copy bar while streaming');
});

test('user text is shown as plain text, not parsed as Markdown or HTML', () => {
  const html = renderToStaticMarkup(
    h(MessageBubble, { message: { id: 'u', role: 'user', content: '**bold** <b>x</b>' } }),
  );
  assert.ok(html.includes('**bold** &lt;b&gt;x&lt;/b&gt;'));
});

test('completed replies get a copy action with an accessible name', () => {
  assert.match(assistant('Hello'), /aria-label="Copy response"/);
});

test('a pending reply shows progress text, not a blank bubble', () => {
  const html = renderToStaticMarkup(
    h(MessageBubble, { message: { id: 'p', role: 'assistant', content: '', status: 'pending' }, phase: 'connecting' }),
  );
  assert.match(html, /Connecting…/);
});

test('failed replies explain the problem, offer Retry only when allowed, and mark partial text', () => {
  const err = { status: 'error', error: 'The connection was lost.' };
  const withRetry = renderToStaticMarkup(
    h(MessageBubble, { message: { id: 'e', role: 'assistant', content: '', ...err }, canRetry: true }),
  );
  assert.match(withRetry, /role="alert"/);
  assert.match(withRetry, /Request failed/);
  assert.match(withRetry, /The connection was lost\./);
  assert.match(withRetry, />Retry</);

  const noRetry = renderToStaticMarkup(
    h(MessageBubble, { message: { id: 'e', role: 'assistant', content: 'Half', ...err }, canRetry: false }),
  );
  assert.ok(!/>Retry</.test(noRetry));
  assert.match(noRetry, /Response incomplete/);
  assert.match(noRetry, /is-partial/);
});

test('stopped replies say so', () => {
  const html = renderToStaticMarkup(
    h(MessageBubble, { message: { id: 's', role: 'assistant', content: 'Half', status: 'stopped' } }),
  );
  assert.match(html, /Generation stopped\. This response is incomplete\./);
});

test('composer: accessible names, disabled empty send, and a stop button while generating', () => {
  const base = { value: '', onChange() {}, onSend() {}, onStop() {} };
  const idle = renderToStaticMarkup(h(InputArea, { ...base, isGenerating: false }));
  assert.match(idle, /aria-label="Message Mitra AI"/);
  assert.match(idle, /<button type="submit"[^>]*disabled=""[^>]*aria-label="Send message"/);
  assert.match(idle, /Enter to send · Shift\+Enter for a new line/);

  const typed = renderToStaticMarkup(h(InputArea, { ...base, value: 'hi', isGenerating: false }));
  assert.ok(!/<button type="submit"[^>]*disabled/.test(typed));

  const busy = renderToStaticMarkup(h(InputArea, { ...base, value: 'hi', isGenerating: true, phase: 'streaming' }));
  assert.match(busy, /<button type="button" class="send-btn is-stop" aria-label="Stop generating"/);
  assert.match(busy, /Mitra AI is responding…/);
});

const sessions = [
  { id: 'a', title: 'Trip plan', updatedAt: new Date().toISOString(), messages: [{ content: 'flights to Lisbon' }] },
  { id: 'b', title: 'DNS notes', updatedAt: new Date().toISOString(), messages: [{ content: 'records' }] },
];
const sidebarProps = {
  sessions, activeSessionId: 'a', isOpen: true, onClose() {}, onSelect() {}, onNewChat() {},
  onRename() {}, onDelete() {}, onDeleteAll() {}, onDismissWarning() {},
};

test('sidebar: chats are real buttons, active chat is marked, icon buttons have names', () => {
  const html = renderToStaticMarkup(h(Sidebar, sidebarProps));
  assert.match(html, /<button type="button" class="session-main" aria-current="true"/);
  assert.match(html, /aria-label="Rename chat: Trip plan"/);
  assert.match(html, /aria-label="Delete chat: DNS notes"/);
  assert.match(html, /aria-label="Search chats"/);
  assert.match(html, /aria-label="Close sidebar"/);
  assert.match(html, /Chats are saved to your account\. Your messages are sent to an external AI service/);
  assert.match(renderToStaticMarkup(h(Sidebar, { ...sidebarProps, isGuest: true })), /Guest chats are saved in this browser only\. Your messages are sent to an external AI service/);
  assert.ok(!/<div[^>]*class="session-item/.test(html));
});

test('sidebar: closed state is inert, empty history has a message, warnings are announced', () => {
  assert.match(renderToStaticMarkup(h(Sidebar, { ...sidebarProps, isOpen: false })), /inert=""/);
  const empty = renderToStaticMarkup(h(Sidebar, { ...sidebarProps, sessions: [], activeSessionId: null }));
  assert.match(empty, /No saved chats yet/);
  const warn = renderToStaticMarkup(h(Sidebar, { ...sidebarProps, storageWarning: 'Storage is full.' }));
  assert.match(warn, /role="alert"[^>]*>[^]*Storage is full\./);
});

test('conversation view: static welcome with real suggestion buttons, no AI call involved', () => {
  const props = { messages: [], request: null, onRetryMessage() {}, onPickSuggestion() {} };
  const empty = renderToStaticMarkup(h(ChatContainer, props));
  assert.match(empty, /How can I help you today\?/);
  assert.equal(empty.match(/class="suggestion"/g).length, 4);

  const talked = renderToStaticMarkup(h(ChatContainer, { ...props, messages: [{ id: 'u', role: 'user', content: 'hello' }] }));
  assert.ok(!/How can I help/.test(talked));
  assert.match(talked, /role="log"/);

  const older = renderToStaticMarkup(h(ChatContainer, { ...props, messages: [{ id: 'u', role: 'user', content: 'hello' }], hasMore: true, onLoadOlder() {} }));
  assert.match(older, />Load earlier messages</);
  const loading = renderToStaticMarkup(h(ChatContainer, { ...props, loading: true }));
  assert.match(loading, /Loading conversation/);
  assert.ok(!/How can I help/.test(loading));
});

test('confirm dialog uses a labelled alert dialog and only renders content when open', () => {
  const props = { title: 'Delete?', description: 'Gone.', onConfirm() {}, onCancel() {} };
  const closed = renderToStaticMarkup(h(ConfirmDialog, { ...props, open: false }));
  assert.ok(!closed.includes('Delete?'));
  const open = renderToStaticMarkup(h(ConfirmDialog, { ...props, open: true }));
  assert.match(open, /role="alertdialog"/);
  assert.match(open, /aria-labelledby/);
  assert.match(open, /autofocus/i);
});

const noop = () => {};

test('auth dialog: labelled email/password fields, show-password toggle, recovery and mode switch links', () => {
  const html = renderToStaticMarkup(h(AuthMod.default, { open: true, initialMode: 'signin', onClose: noop, onSignIn: noop, onSignUp: noop, onForgot: noop }));
  assert.match(html, /<h2[^>]*>Sign in<\/h2>/);
  assert.match(html, /<label[^>]*>Email<\/label>/);
  assert.match(html, /<label[^>]*>Password<\/label>/);
  assert.match(html, /autoComplete="current-password"|autocomplete="current-password"/i);
  assert.match(html, /aria-label="Show password"[^>]*aria-pressed="false"|aria-pressed="false"[^>]*aria-label="Show password"/);
  assert.match(html, />Forgot password\?</);
  assert.match(html, />Create an account</);
  assert.match(html, /aria-label="Close"/);
  const signup = renderToStaticMarkup(h(AuthMod.default, { open: true, initialMode: 'signup', onClose: noop, onSignIn: noop, onSignUp: noop, onForgot: noop }));
  assert.match(signup, /Create your account/);
  assert.match(signup, /new-password/i);
  assert.match(signup, /At least 8 characters/);
  assert.equal(renderToStaticMarkup(h(AuthMod.default, { open: false, onClose: noop, onSignIn: noop, onSignUp: noop, onForgot: noop })).includes('Email'), false);
});

test('password reset dialog asks for and confirms a new password', () => {
  const html = renderToStaticMarkup(h(AuthMod.ResetPasswordDialog, { open: true, onSubmit: noop, onClose: noop }));
  assert.match(html, /Choose a new password/);
  assert.match(html, /Confirm new password/);
});

test('guest limit dialog: explains the allowance, offers sign-in/registration and a way back; nothing is cleared', () => {
  const limit = { kind: 'guest', usage: { used: 5, limit: 5, remaining: 0 }, restoredText: 'q' };
  const html = renderToStaticMarkup(h(LimitDialog, { limit, limits: { guest: 5, user: 100 }, onSignIn: noop, onRegister: noop, onClose: noop }));
  assert.match(html, /used your free questions/);
  assert.match(html, /5 questions without an account/);
  assert.match(html, /100 questions per day/);
  assert.match(html, />Create account</);
  assert.match(html, />Sign in</);
  assert.match(html, />Back to my conversation</);
  assert.match(html, /Nothing is deleted/);
  assert.match(html, /role="alertdialog"/);
  const user = renderToStaticMarkup(h(LimitDialog, { limit: { kind: 'user', usage: { limit: 100, resetsAt: '2026-10-12T00:00:00.000Z' } }, limits: null, onSignIn: noop, onRegister: noop, onClose: noop }));
  assert.match(user, /reached today/);
  assert.ok(!/Create account/.test(user));
  assert.equal(renderToStaticMarkup(h(LimitDialog, { limit: null, onSignIn: noop, onRegister: noop, onClose: noop })).includes('free questions'), false);
});

test('import dialog uses the required wording, offers import or skip, and shows progress and errors', () => {
  const base = { open: true, count: 2, progress: { done: 1, total: 2 }, busy: false, onImport: noop, onSkip: noop };
  const html = renderToStaticMarkup(h(ImportDialog, base));
  assert.match(html, /Save your guest conversations to your account\?/);
  assert.match(html, />Skip</);
  assert.match(html, />Import</);
  assert.match(html, /2 conversations/);
  const busy = renderToStaticMarkup(h(ImportDialog, { ...base, busy: true }));
  assert.match(busy, /<progress/);
  assert.match(busy, /Importing 1 of 2/);
  const failed = renderToStaticMarkup(h(ImportDialog, { ...base, error: 'The import did not finish.' }));
  assert.match(failed, /role="alert"/);
  assert.match(failed, />Try again</);
  assert.match(renderToStaticMarkup(h(ImportDialog, { ...base, depth: 'detailed', carryDepth: true, onCarryDepth: noop })), /detailed response style/);
});

test('usage badge: guests always see the remaining allowance; users only when it runs low', () => {
  assert.match(renderToStaticMarkup(h(UsageBadge, { kind: 'guest', usage: { remaining: 3, limit: 5 } })), /3 of 5 free questions left/);
  assert.match(renderToStaticMarkup(h(UsageBadge, { kind: 'guest', usage: { remaining: 0, limit: 5 } })), /is-empty/);
  assert.equal(renderToStaticMarkup(h(UsageBadge, { kind: 'user', usage: { remaining: 80, limit: 100 } })), '');
  assert.match(renderToStaticMarkup(h(UsageBadge, { kind: 'user', usage: { remaining: 4, limit: 100 } })), /4 left today/);
  assert.equal(renderToStaticMarkup(h(UsageBadge, { kind: 'guest', usage: null })), '');
});

test('account menu: guests get Sign in, users get an accessibly named menu button', () => {
  assert.match(renderToStaticMarkup(h(AccountMenu, { user: null, onSignIn: noop, onProfile: noop, onSettings: noop, onSignOut: noop })), />Sign in</);
  const base = { onSignIn: noop, onProfile: noop, onSettings: noop, onSignOut: noop };
  const html = renderToStaticMarkup(h(AccountMenu, { ...base, user: { email: 'ada@example.com' } }));
  assert.match(html, /aria-label="Account menu for ada"/, 'falls back to the email name');
  const named = renderToStaticMarkup(h(AccountMenu, { ...base, user: { email: 'ada@example.com' }, profile: { displayName: 'Ada Lovelace' }, avatarUrl: 'https://storage.test/a.webp' }));
  assert.match(named, /aria-label="Account menu for Ada Lovelace"/);
  assert.match(named, /<img src="https:\/\/storage\.test\/a\.webp"/);
  assert.match(html, /aria-haspopup="menu"/);
  assert.match(html, />A</);
});

const account = {
  depth: 'balanced', setDepth: noop, error: null, settings: { memory_enabled: true, auto_memory: true },
  memories: [{ id: 'm1', content: 'I prefer TypeScript', enabled: true }, { id: 'm2', content: 'Old note', enabled: false }],
  setMemoryEnabled: noop, setAutoMemory: noop, addMemory: noop, updateMemory: noop, removeMemory: noop, clearMemories: noop,
};

test('memory panel: list, per-item controls with names, switches, add field and clear-all', () => {
  const html = renderToStaticMarkup(h(MemoryPanel, {
    settings: account.settings, memories: account.memories, error: null, onMemoryEnabled: noop, onAutoMemory: noop,
    onAdd: noop, onUpdate: noop, onRemove: noop, onClearAll: noop,
  }));
  assert.match(html, /I prefer TypeScript/);
  assert.match(html, /aria-label="Edit memory: I prefer TypeScript"/);
  assert.match(html, /aria-label="Delete memory: I prefer TypeScript"/);
  assert.match(html, /aria-label="Use this memory: Old note"/);
  assert.match(html, /memory-item is-off/);
  assert.match(html, /role="switch"/);
  assert.match(html, />Use memory</);
  assert.match(html, />Suggest memories</);
  assert.match(html, /Nothing is saved without your confirmation/);
  assert.match(html, />Clear all memories</);
  assert.match(html, /Never save passwords or keys/);
  const empty = renderToStaticMarkup(h(MemoryPanel, { ...{ settings: account.settings, memories: [], error: 'x', onMemoryEnabled: noop, onAutoMemory: noop, onAdd: noop, onUpdate: noop, onRemove: noop, onClearAll: noop } }));
  assert.match(empty, /No saved memories yet/);
  assert.ok(!/Clear all memories/.test(empty));
});

test('settings dialog: guests and users see the right sections; depth choices and honest model note are present', () => {
  const base = { open: true, onClose: noop, usage: { used: 2, limit: 100, remaining: 98, resetsAt: '2026-10-12T00:00:00.000Z' }, limits: { guest: 5, user: 100 }, account, theme: 'light', onToggleTheme: noop, onSignIn: noop, onProfile: noop, onDeleteChats: noop, onDeleteAccount: noop };
  const signed = renderToStaticMarkup(h(SettingsDialog, { ...base, user: { email: 'ada@example.com' } }));
  assert.match(signed, /ada@example\.com/);
  assert.match(signed, /2 of 100 used/);
  assert.match(signed, />Concise</);
  assert.match(signed, />Balanced</);
  assert.match(signed, />Detailed</);
  assert.match(signed, /checked=""[^>]*value="balanced"|value="balanced"[^>]*checked=""/);
  assert.match(signed, /underlying AI model comes from an external provider and is not changed/);
  assert.match(signed, />Use memory</);
  assert.match(signed, /Delete account…/);
  assert.match(signed, />Edit profile</);
  assert.ok(!/>Sign out</.test(signed), 'sign out lives in the account menu only');
  assert.match(signed, /sent to an external AI service/);

  const guest = renderToStaticMarkup(h(SettingsDialog, { ...base, user: null, usage: { used: 2, limit: 5, remaining: 3 } }));
  assert.match(guest, /3 of 5 free questions left/);
  assert.match(guest, /raises the limit to 100 questions per day/);
  assert.match(guest, /Memory is available with an account/);
  assert.ok(!/Delete account…/.test(guest));
  assert.match(guest, /stored only in this browser/);
});

test('memory banner: suggestions need an explicit Save; saved notes can be undone; errors are alerts', () => {
  const props = { onAccept: noop, onDismiss: noop, onDismissNotice: noop, onUndo: noop, onManage: noop };
  const sug = renderToStaticMarkup(h(MemoryBanner, { ...props, suggestion: { text: 'I prefer Python' }, notice: null }));
  assert.match(sug, /Save to memory/);
  assert.match(sug, />Save</);
  assert.match(sug, />Not now</);
  const saved = renderToStaticMarkup(h(MemoryBanner, { ...props, suggestion: null, notice: { kind: 'saved', text: 'I use Vite', id: 'x' } }));
  assert.match(saved, /Saved to memory/);
  assert.match(saved, />Undo</);
  const err = renderToStaticMarkup(h(MemoryBanner, { ...props, suggestion: null, notice: { kind: 'error', text: 'Not saved.' } }));
  assert.match(err, /role="alert"/);
  assert.equal(renderToStaticMarkup(h(MemoryBanner, { ...props, suggestion: null, notice: null })), '');
});

const profileState = (extra = {}) => ({
  ownerId: 'u1', status: 'ready', saving: false, error: null, avatarUrl: null,
  profile: { displayName: 'Ada', avatarPath: null, createdAt: '2026-01-02T00:00:00Z' }, ...extra,
});
const profileActions = { saveDisplayName: noop, uploadAvatar: noop, removeAvatar: noop, retry: noop };
const profileUser = { email: 'ada@example.com', created_at: '2026-01-02T10:00:00Z', email_confirmed_at: '2026-01-02T10:05:00Z' };

test('profile dialog: labelled name field, upload control, read-only account facts, disabled Save until edited', () => {
  const html = renderToStaticMarkup(h(ProfileDialog, { open: true, onClose: noop, user: profileUser, state: profileState(), actions: profileActions }));
  assert.match(html, /<h2[^>]*>Profile<\/h2>/);
  assert.match(html, /<label[^>]*>Display name<\/label>/);
  assert.match(html, /value="Ada"/);
  assert.match(html, />Upload photo</);
  assert.ok(!/Remove photo/.test(html), 'nothing to remove yet');
  assert.match(html, /accept="image\/png,image\/jpeg,image\/webp"/);
  assert.match(html, /aria-label="Choose a profile photo"/);
  assert.match(html, /<dt>Email<\/dt><dd>ada@example\.com<\/dd>/);
  assert.match(html, /Confirmed /);
  assert.match(html, /Member since/);
  assert.match(html, /<button type="submit" class="btn btn-primary" disabled="">Save changes<\/button>/);
  assert.match(html, />Close<\/button>/);
  assert.match(html, /stored privately/);
});

test('profile dialog: with a photo it offers Change/Remove; shows loading, error-with-retry and saving states', () => {
  const withPhoto = renderToStaticMarkup(h(ProfileDialog, { open: true, onClose: noop, user: profileUser, state: profileState({ avatarUrl: 'https://storage.test/a.webp', profile: { displayName: null, avatarPath: 'u/x.webp' } }), actions: profileActions }));
  assert.match(withPhoto, />Change photo</);
  assert.match(withPhoto, />Remove photo</);
  assert.match(withPhoto, /<img src="https:\/\/storage\.test\/a\.webp"/);
  assert.match(withPhoto, /Leave blank to use “ada”/);
  assert.match(renderToStaticMarkup(h(ProfileDialog, { open: true, onClose: noop, user: profileUser, state: profileState({ status: 'loading', profile: null }), actions: profileActions })), /Loading your profile/);
  const failed = renderToStaticMarkup(h(ProfileDialog, { open: true, onClose: noop, user: profileUser, state: profileState({ status: 'error', profile: null, error: "Your profile couldn't be loaded." }), actions: profileActions }));
  assert.match(failed, /role="alert"/);
  assert.match(failed, />Retry</);
  const saving = renderToStaticMarkup(h(ProfileDialog, { open: true, onClose: noop, user: profileUser, state: profileState({ saving: true }), actions: profileActions }));
  assert.match(saving, /Saving…/);
  assert.match(saving, /<button type="button" class="btn btn-sm" disabled="">Upload photo/);
  assert.equal(renderToStaticMarkup(h(ProfileDialog, { open: false, onClose: noop, user: profileUser, state: profileState(), actions: profileActions })).includes('Display name'), false);
});

test('avatar: image when there is a URL, the initial otherwise; always hidden from assistive tech', () => {
  assert.match(renderToStaticMarkup(h(Avatar, { name: 'Ada', url: 'https://storage.test/a.webp', size: 40 })), /<img src="https:\/\/storage\.test\/a\.webp" alt=""/);
  const initial = renderToStaticMarkup(h(Avatar, { name: 'ada', size: 40 }));
  assert.match(initial, />A<\/span>/);
  assert.match(initial, /aria-hidden="true"/);
  assert.ok(!/<img/.test(initial));
});

test('sign-up form offers an optional display name; sign-in does not', () => {
  const up = renderToStaticMarkup(h(AuthMod.default, { open: true, initialMode: 'signup', onClose: noop, onSignIn: noop, onSignUp: noop, onForgot: noop }));
  assert.match(up, /Display name <span class="field-optional">\(optional\)/);
  const inn = renderToStaticMarkup(h(AuthMod.default, { open: true, initialMode: 'signin', onClose: noop, onSignIn: noop, onSignUp: noop, onForgot: noop }));
  assert.ok(!/Display name/.test(inn));
});

test('latest replies get a Regenerate action; failed replies keep Retry; busy chats offer neither', () => {
  const done = renderToStaticMarkup(h(MessageBubble, { message: { id: '1', role: 'assistant', content: 'Hi', status: 'complete' }, canRegenerate: true, onRetry: noop }));
  assert.match(done, /aria-label="Regenerate response"/);
  assert.match(done, /uses one question/);
  assert.ok(!renderToStaticMarkup(h(MessageBubble, { message: { id: '1', role: 'assistant', content: 'Hi', status: 'complete' } })).includes('Regenerate'));
  const stopped = renderToStaticMarkup(h(MessageBubble, { message: { id: '1', role: 'assistant', content: '', status: 'stopped' }, canRegenerate: true }));
  assert.match(stopped, /Regenerate/);
  const failed = renderToStaticMarkup(h(MessageBubble, { message: { id: '1', role: 'assistant', content: '', status: 'error', error: 'x' }, canRetry: true }));
  assert.match(failed, />Retry</);
  assert.ok(!failed.includes('Regenerate'));
});
