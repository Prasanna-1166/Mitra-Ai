import test from 'node:test';
import assert from 'node:assert/strict';
import { isSendKey } from '../src/lib/composer.js';
import { isNearBottom } from '../src/lib/scroll.js';
import { copyText } from '../src/lib/clipboard.js';
import { makeId } from '../src/lib/ids.js';

test('Enter sends; Shift+Enter, IME composition and other keys do not', () => {
  assert.equal(isSendKey({ key: 'Enter', shiftKey: false }), true);
  assert.equal(isSendKey({ key: 'Enter', shiftKey: true }), false);
  assert.equal(isSendKey({ key: 'Enter', shiftKey: false, isComposing: true }), false);
  assert.equal(isSendKey({ key: 'Enter', shiftKey: false, keyCode: 229 }), false);
  assert.equal(isSendKey({ key: 'a', shiftKey: false }), false);
});

test('isNearBottom respects a reader who has scrolled up', () => {
  assert.equal(isNearBottom({ scrollTop: 920, scrollHeight: 1000, clientHeight: 80 }), true);
  assert.equal(isNearBottom({ scrollTop: 900, scrollHeight: 1000, clientHeight: 80 }), true);
  assert.equal(isNearBottom({ scrollTop: 200, scrollHeight: 1000, clientHeight: 80 }), false);
  assert.equal(isNearBottom({ scrollTop: 0, scrollHeight: 50, clientHeight: 80 }), true);
});

test('copyText reports success and failure without throwing', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const setNav = (value) => Object.defineProperty(globalThis, 'navigator', { value, configurable: true });
  try {
    let copied = null;
    setNav({ clipboard: { writeText: async (t) => { copied = t; } } });
    assert.equal(await copyText('abc'), true);
    assert.equal(copied, 'abc');

    setNav({ clipboard: { writeText: async () => { throw new Error('denied'); } } });
    assert.equal(await copyText('abc'), false); // no DOM fallback available in Node
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
  }
});

test('makeId works without crypto.randomUUID', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true });
  try {
    const a = makeId();
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notEqual(a, makeId());
  } finally {
    Object.defineProperty(globalThis, 'crypto', original);
  }
});
