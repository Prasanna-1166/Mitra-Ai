import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadModule } from './helpers.js';

let MessageBubble, InputArea, Sidebar, ChatContainer, ConfirmDialog;
before(async () => {
  MessageBubble = (await loadModule('src/components/MessageBubble.jsx')).default;
  InputArea = (await loadModule('src/components/InputArea.jsx')).default;
  Sidebar = (await loadModule('src/components/Sidebar.jsx')).default;
  ChatContainer = (await loadModule('src/components/ChatContainer.jsx')).default;
  ConfirmDialog = (await loadModule('src/components/ConfirmDialog.jsx')).default;
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
  assert.match(html, /Chats are saved in this browser only/);
  assert.ok(!/<div[^>]*class="session-item/.test(html));
});

test('sidebar: closed state is inert, empty history has a message, warnings are announced', () => {
  assert.match(renderToStaticMarkup(h(Sidebar, { ...sidebarProps, isOpen: false })), /inert=""/);
  const empty = renderToStaticMarkup(h(Sidebar, { ...sidebarProps, sessions: [], activeSessionId: null }));
  assert.match(empty, /No saved chats yet/);
  const warn = renderToStaticMarkup(h(Sidebar, { ...sidebarProps, storageWarning: 'Storage is full.' }));
  assert.match(warn, /role="alert"[^>]*>[^]*Storage is full\./);
});

test('conversation view: empty state offers real suggestion buttons; greeting-only chats do too', () => {
  const props = { messages: [], request: null, onRetryMessage() {}, onRetryWelcome() {}, onPickSuggestion() {} };
  const empty = renderToStaticMarkup(h(ChatContainer, props));
  assert.match(empty, /How can I help you today\?/);
  assert.equal(empty.match(/class="suggestion"/g).length, 4);

  const failed = renderToStaticMarkup(h(ChatContainer, { ...props, welcomeError: 'Could not connect.' }));
  assert.match(failed, /role="alert"/);
  assert.match(failed, />Retry</);

  const greeted = renderToStaticMarkup(
    h(ChatContainer, { ...props, messages: [{ id: 'g', role: 'assistant', content: 'Hi!', status: 'complete' }] }),
  );
  assert.match(greeted, /Try asking/);
  const talked = renderToStaticMarkup(
    h(ChatContainer, { ...props, messages: [{ id: 'u', role: 'user', content: 'hello' }] }),
  );
  assert.ok(!/Try asking/.test(talked));
  assert.match(talked, /role="log"/);
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
