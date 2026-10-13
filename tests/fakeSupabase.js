// In-memory fake of the parts of supabase-js this app uses. It emulates what the
// real database enforces for these tables (ownership by auth uid, unique keys,
// the composite foreign key, column-level update grants, ordering, cascades) so
// the services and the controller can be tested. It is NOT Supabase: the real
// row-level security is covered only by supabase/tests/rls.test.sql.
const OWNED = ['conversations', 'messages', 'user_memories', 'user_settings', 'profiles'];
const UPDATABLE = {
  conversations: ['title', 'title_source'],
  user_memories: ['content', 'category', 'enabled'],
  user_settings: ['response_depth', 'memory_enabled', 'auto_memory'],
  messages: [],
  profiles: ['display_name', 'avatar_path'],
};
const UNIQUE = {
  conversations: [['id'], ['user_id', 'import_key']],
  messages: [['id'], ['conversation_id', 'client_id']],
  user_memories: [['id']],
  user_settings: [['user_id']],
  profiles: [['user_id']],
};
const AVATAR_RE = /^([0-9a-f-]{36})\/[0-9a-f-]{36}\.(png|jpg|webp)$/;
const checkProfile = (row) => {
  if (row.display_name != null && (row.display_name.length < 1 || row.display_name.length > 50 || [...row.display_name].some((c) => c.charCodeAt(0) < 32))) return err('23514', 'profiles_display_name_check');
  if (row.avatar_path != null) {
    const m = AVATAR_RE.exec(row.avatar_path);
    if (!m || m[1] !== row.user_id) return err('23514', 'profiles_avatar_path_check');
  }
  return null;
};

let counter = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
const err = (code, message) => ({ code, message });

export class FakeSupabase {
  constructor() {
    this.tables = { conversations: [], messages: [], user_memories: [], user_settings: [], profiles: [] };
    this.objects = new Map(); // storage objects: path -> { type, size, owner }
    this.storageFail = null; // { op, error? }
    this.storage = new FakeStorage(this);
    this.uid = null;
    this.seq = 0;
    this.clock = 0;
    this.failNext = null; // { table, op } -> next matching call returns an error
    this.calls = [];
  }
  now() {
    this.clock += 1;
    return new Date(Date.UTC(2026, 0, 1, 0, 0, this.clock)).toISOString();
  }
  from(table) {
    return new Query(this, table);
  }
  async rpc(name, args) {
    this.calls.push(['rpc', name, args]);
    if (name === 'search_conversations') {
      const q = String(args.p_query).trim().toLowerCase();
      if (!q) return { data: [], error: null };
      const mine = this.tables.conversations.filter((c) => c.user_id === this.uid);
      const ids = mine
        .filter((c) => c.title.toLowerCase().includes(q) || this.tables.messages.some((m) => m.conversation_id === c.id && m.user_id === this.uid && m.content.toLowerCase().includes(q)))
        .map((c) => c.id);
      return { data: ids, error: null };
    }
    return { data: null, error: err('42883', 'unknown function') };
  }
  // Emulates the account-deletion cascade for this fake.
  deleteUserData(uid) {
    for (const t of Object.keys(this.tables)) this.tables[t] = this.tables[t].filter((r) => r.user_id !== uid);
  }
  // Rows as another account would see them (for isolation assertions).
  rowsOf(table, uid) {
    return this.tables[table].filter((r) => r.user_id === uid);
  }
}

class Query {
  constructor(db, table) {
    Object.assign(this, { db, table, op: 'select', filters: [], orderBy: null, max: null, mode: 'many', returning: false });
  }
  select(cols) {
    if (this.op !== 'select') this.returning = true;
    this.cols = cols && cols !== '*' ? cols.split(',').map((c) => c.trim()) : null;
    return this;
  }
  insert(rows) { this.op = 'insert'; this.rows = [].concat(rows); this.single0 = !Array.isArray(rows); return this; }
  upsert(rows, opts = {}) { this.op = 'upsert'; this.rows = [].concat(rows); this.opts = opts; return this; }
  update(patch) { this.op = 'update'; this.patch = patch; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(c, v) { this.filters.push((r) => r[c] === v); return this; }
  lt(c, v) { this.filters.push((r) => r[c] < v); return this; }
  order(c, { ascending = true } = {}) { this.orderBy = { c, ascending }; return this; }
  limit(n) { this.max = n; return this; }
  single() { this.mode = 'single'; return this; }
  maybeSingle() { this.mode = 'maybe'; return this; }
  then(resolve, reject) { return this.run().then(resolve, reject); }

  async run() {
    const { db, table } = this;
    db.calls.push([this.op, table]);
    if (db.failNext && db.failNext.table === table && db.failNext.op === this.op) {
      const e = db.failNext.error ?? err('XX000', 'forced failure');
      db.failNext = null;
      return { data: null, error: e };
    }
    if (db.uid === null) return { data: null, error: err('42501', 'permission denied') };
    const rows = db.tables[table];
    let result = [];
    if (this.op === 'select') result = this.matching(rows);
    else if (this.op === 'insert' || this.op === 'upsert') {
      for (const input of this.rows) {
        const row = { ...input };
        if (OWNED.includes(table) && row.user_id !== db.uid) return { data: null, error: err('42501', 'new row violates row-level security policy') };
        const conflictCols = this.opts?.onConflict?.split(',');
        const clash = rows.find((r) => UNIQUE[table].some((cols) => cols.every((c) => row[c] != null && r[c] === row[c])));
        if (clash) {
          if (this.op === 'upsert' && this.opts?.ignoreDuplicates && (!conflictCols || UNIQUE[table].some((u) => u.length === conflictCols.length && u.every((c) => conflictCols.includes(c))))) continue;
          return { data: null, error: err('23505', 'duplicate key value violates unique constraint') };
        }
        if (table === 'messages') {
          const conv = db.tables.conversations.find((c) => c.id === row.conversation_id && c.user_id === row.user_id);
          if (!conv) return { data: null, error: err('23503', 'violates foreign key constraint') };
          if (row.content.length > 60000) return { data: null, error: err('23514', 'check violation') };
          row.id = row.id ?? uuid();
          row.seq = ++db.seq;
          row.created_at = row.created_at ?? db.now();
          row.status = row.status ?? 'complete';
          conv.updated_at = db.now();
          conv.last_message_at = conv.updated_at;
        } else if (table === 'conversations') {
          row.id = row.id ?? uuid();
          row.created_at = row.created_at ?? db.now();
          row.updated_at = row.created_at;
          row.title_source = row.title_source ?? 'default';
          row.import_key = row.import_key ?? null;
          if (!row.title || row.title.length > 120) return { data: null, error: err('23514', 'check violation') };
        } else if (table === 'user_memories') {
          if (!row.content || row.content.length > 500) return { data: null, error: err('23514', 'check violation') };
          if (rows.filter((r) => r.user_id === db.uid).length >= 200) return { data: null, error: err('54000', 'memory limit reached') };
          Object.assign(row, { id: row.id ?? uuid(), category: row.category ?? 'other', source: row.source ?? 'user', enabled: true, created_at: db.now(), updated_at: db.now() });
        } else if (table === 'profiles') {
          Object.assign(row, { display_name: null, avatar_path: null, created_at: db.now(), updated_at: db.now(), ...row });
          const bad = checkProfile(row);
          if (bad) return { data: null, error: bad };
        } else if (table === 'user_settings') {
          Object.assign(row, { response_depth: 'balanced', memory_enabled: true, auto_memory: true, ...row });
        }
        rows.push(row);
        result.push(row);
      }
    } else if (this.op === 'update') {
      for (const k of Object.keys(this.patch)) {
        if (!UPDATABLE[table].includes(k)) return { data: null, error: err('42501', `permission denied for column ${k}`) };
      }
      result = this.matching(rows);
      if (table === 'profiles') {
        for (const r of result) {
          const bad = checkProfile({ ...r, ...this.patch });
          if (bad) return { data: null, error: bad };
        }
      }
      result.forEach((r) => Object.assign(r, this.patch, table === 'profiles' ? { updated_at: db.now() } : {}));
    } else if (this.op === 'delete') {
      const doomed = this.matching(rows);
      db.tables[table] = rows.filter((r) => !doomed.includes(r));
      if (table === 'conversations') {
        const ids = new Set(doomed.map((c) => c.id));
        db.tables.messages = db.tables.messages.filter((m) => !ids.has(m.conversation_id));
      }
      result = doomed;
    }
    const wantData = this.op === 'select' || this.returning;
    const copies = result.map((r) => (this.cols ? Object.fromEntries(this.cols.map((c) => [c, r[c]])) : { ...r }));
    if (!wantData) return { data: null, error: null };
    if (this.mode === 'single') {
      return copies.length === 1 ? { data: copies[0], error: null } : { data: null, error: err('PGRST116', 'expected one row') };
    }
    if (this.mode === 'maybe') return { data: copies[0] ?? null, error: null };
    return { data: copies, error: null };
  }
  matching(rows) {
    const { db, table } = this;
    let out = rows.filter((r) => (!OWNED.includes(table) || r.user_id === db.uid) && this.filters.every((f) => f(r)));
    if (this.orderBy) {
      const { c, ascending } = this.orderBy;
      out = [...out].sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (ascending ? 1 : -1));
    }
    return this.max != null && this.op === 'select' ? out.slice(0, this.max) : out;
  }
}

const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const LIMIT = 2097152;
const denied = () => ({ data: null, error: { message: 'new row violates row-level security policy', statusCode: '403' } });

// Private "avatars" bucket with the same rules as the storage policies: objects
// live under <own user id>/, images only, 2 MB, no overwrite without upsert.
class FakeStorage {
  constructor(db) { this.db = db; }
  from(bucket) {
    const { db } = this;
    const mine = (path) => path.split('/')[0] === db.uid;
    const forced = (op) => { if (db.storageFail?.op === op) { const e = db.storageFail.error ?? { message: 'storage failure' }; db.storageFail = null; return { data: null, error: e }; } return null; };
    return {
      async upload(path, blob, opts = {}) {
        if (bucket !== 'avatars') return { data: null, error: { message: 'Bucket not found' } };
        const f = forced('upload'); if (f) return f;
        if (db.uid === null || !mine(path)) return denied();
        if (!ALLOWED_TYPES.includes(opts.contentType)) return { data: null, error: { message: 'mime type not supported' } };
        if (blob.size > LIMIT) return { data: null, error: { message: 'The object exceeded the maximum allowed size' } };
        if (db.objects.has(path) && !opts.upsert) return { data: null, error: { message: 'The resource already exists' } };
        db.objects.set(path, { type: opts.contentType, size: blob.size });
        return { data: { path }, error: null };
      },
      async remove(paths) {
        const f = forced('remove'); if (f) return f;
        const removed = [];
        for (const p of paths) if (db.uid !== null && mine(p) && db.objects.delete(p)) removed.push({ name: p });
        return { data: removed, error: null };
      },
      async createSignedUrl(path) {
        const f = forced('sign'); if (f) return f;
        if (db.uid === null || !mine(path) || !db.objects.has(path)) return { data: null, error: { message: 'Object not found' } };
        return { data: { signedUrl: `https://storage.test/sign/${bucket}/${path}?token=t` }, error: null };
      },
      async list(prefix) {
        if (db.uid === null || prefix !== db.uid) return { data: [], error: null };
        return { data: [...db.objects.keys()].filter((k) => k.startsWith(`${prefix}/`)).map((k) => ({ name: k.slice(prefix.length + 1) })), error: null };
      },
    };
  }
}
