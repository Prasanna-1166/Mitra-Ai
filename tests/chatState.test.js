import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TITLE,
  conversationToMarkdown,
  deriveTitle,
  exportFilename,
  formatRelativeTime,
  matchesSearch,
  sanitizeTitle,
} from '../src/lib/chatState.js';

test('deriveTitle uses the first meaningful line', () => {
  assert.equal(deriveTitle('  Explain how DNS works  '), 'Explain how DNS works');
  assert.equal(deriveTitle('## Plan my week'), 'Plan my week');
  assert.equal(deriveTitle('- 1. fix this bug'), 'fix this bug'); // list markers are stripped
  assert.equal(deriveTitle('2024 trends in AI'), '2024 trends in AI');
  assert.equal(deriveTitle('\n\n   \nSecond line wins'), 'Second line wins');
});

test('deriveTitle skips input with no real words', () => {
  assert.equal(deriveTitle('??'), null);
  assert.equal(deriveTitle('   '), null);
  assert.equal(deriveTitle('```\n```'), null);
  assert.equal(deriveTitle(42), null);
});

test('deriveTitle truncates safely on a word boundary', () => {
  const t = deriveTitle('Please explain the difference between TCP and UDP in great detail for me');
  assert.ok(t.endsWith('…'));
  assert.ok(Array.from(t).length <= 49);
  assert.ok(!t.includes('  '));
  const emoji = deriveTitle('😀'.repeat(60) + ' hello');
  assert.ok(!/[\ud800-\udbff]$/.test(emoji.slice(0, -1)), 'no lone surrogate before the ellipsis');
});

test('sanitizeTitle trims, collapses whitespace and limits length', () => {
  assert.equal(sanitizeTitle('  My \n  chat\t'), 'My chat');
  assert.equal(sanitizeTitle(''), '');
  assert.equal(sanitizeTitle(null), '');
  assert.equal(Array.from(sanitizeTitle('x'.repeat(200))).length, 80);
});

test('matchesSearch checks titles and message content, case-insensitively', () => {
  const s = { title: 'Trip plan', messages: [{ content: 'Book flights to Lisbon' }] };
  assert.ok(matchesSearch(s, ''));
  assert.ok(matchesSearch(s, 'TRIP'));
  assert.ok(matchesSearch(s, 'lisbon'));
  assert.ok(!matchesSearch(s, 'paris'));
});

test('formatRelativeTime', () => {
  const now = Date.parse('2026-10-11T12:00:00Z');
  assert.equal(formatRelativeTime('2026-10-11T11:59:50Z', now), 'Just now');
  assert.equal(formatRelativeTime('2026-10-11T11:30:00Z', now), '30m ago');
  assert.equal(formatRelativeTime('2026-10-11T09:00:00Z', now), '3h ago');
  assert.equal(formatRelativeTime('2026-10-09T12:00:00Z', now), '2d ago');
  assert.equal(formatRelativeTime('nope', now), '');
  assert.equal(formatRelativeTime('2026-10-12T12:00:00Z', now), 'Just now');
});

test('export keeps order and roles and flags incomplete replies', () => {
  const session = {
    title: 'Demo / chat?',
    messages: [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello', status: 'complete' },
      { role: 'user', content: 'Again' },
      { role: 'assistant', content: 'Par', status: 'error' },
      { role: 'assistant', content: '', status: 'stopped' },
    ],
  };
  const md = conversationToMarkdown(session, Date.parse('2026-10-11T00:00:00Z'));
  assert.ok(md.startsWith('# Demo / chat?'));
  assert.ok(md.indexOf('## You\n\nHi') < md.indexOf('## Mitra AI\n\nHello'));
  assert.ok(md.includes('Par\n\n_(response incomplete)_'));
  assert.equal(md.match(/## Mitra AI/g).length, 2); // the empty stopped bubble is skipped
  assert.equal(exportFilename(session, Date.parse('2026-10-11T00:00:00Z')), 'mitra-ai-demo-chat-2026-10-11.md');
  assert.equal(exportFilename({ title: '???' }, Date.parse('2026-10-11T00:00:00Z')), 'mitra-ai-conversation-2026-10-11.md');
  assert.equal(DEFAULT_TITLE, 'New chat');
});
