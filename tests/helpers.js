import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A controllable WebSocket. Tests decide when it opens, what it receives and
// how it closes, so nothing ever touches the live provider.
export class FakeWebSocket {
  static instances = [];
  static reset() {
    FakeWebSocket.instances = [];
  }
  static get last() {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  }

  constructor(url) {
    if (FakeWebSocket.throwOnConstruct) throw new Error('bad url');
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.closeCode = null;
    this.onopen = this.onmessage = this.onerror = this.onclose = null;
    FakeWebSocket.instances.push(this);
  }
  send(data) {
    if (this.throwOnSend) throw new Error('send failed');
    this.sent.push(JSON.parse(data));
  }
  close(code) {
    this.closeCode = code;
    this.readyState = 3;
  }
  // --- test controls (they fire whatever handler is currently attached) ---
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  message(data) {
    this.onmessage?.({ data });
  }
  error() {
    this.onerror?.({});
  }
  serverClose(code = 1000) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

export function createFakeTimers() {
  let now = 0;
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeout(fn, ms) {
      const id = nextId++;
      pending.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = target;
    },
    get pendingCount() {
      return pending.size;
    },
  };
}

export class MemoryStorage {
  constructor(initial = {}) {
    this.data = new Map(Object.entries(initial));
    this.writes = 0;
    this.failWrites = false;
  }
  getItem(k) {
    return this.data.has(k) ? this.data.get(k) : null;
  }
  setItem(k, v) {
    if (this.failWrites) throw new Error('QuotaExceededError');
    this.writes += 1;
    this.data.set(k, String(v));
  }
  removeItem(k) {
    this.data.delete(k);
  }
}

export const testConfig = {
  wsUrl: 'wss://example.test/chat',
  appId: 'test-app',
  systemPrompt: 'test prompt',
  welcomePrompt: 'WELCOME',
  connectTimeoutMs: 1000,
  idleTimeoutMs: 2000,
};

// Bundle a component/module with esbuild (JSX automatic, bare imports external)
// and import it, so rendering tests do not need a browser or jsdom.
export async function loadModule(entry) {
  const outDir = path.join(root, 'node_modules', '.cache', 'mitra-tests');
  const outfile = path.join(outDir, `${path.basename(entry).replace(/\W/g, '_')}-${Date.now()}.mjs`);
  await build({
    entryPoints: [path.join(root, entry)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    jsx: 'automatic',
    packages: 'external',
    logLevel: 'silent',
  });
  return import(pathToFileURL(outfile).href);
}
