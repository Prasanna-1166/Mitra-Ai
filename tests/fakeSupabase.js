// In-memory fake of the parts of supabase-js this app uses. It emulates what the
// real database enforces for these tables (ownership by auth uid, unique keys,
// the composite foreign key, column-level update grants, ordering, cascades) so
// the services and the controller can be tested. It is NOT Supabase: the real
// row-level security is covered only by supabase/tests/rls.test.sql.
const OWNED = ['conversations', 'messages', 'user_memories', 'user_settings'];
const UPDATABLE = {
  conversations: ['title', 'title_source'],
  user_memories: ['content', 'category', 'enabled'],
  user_settings: ['response_depth', 'memory_enabled', 'auto_memory'],
  messages: [],
};
const UNIQUE = {
  conversations: [['id'], ['user_id', 'import_key']],
  messages: [['id'], ['conversation_id', 'client_id']],
  user_memories: [['id']],
  user_settings: [['user_id']],
};

let counter = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
const err = (code, message) => ({ code, message });

export class FakeSupabase {
  constructor() {
    this.tables = { conversations: [], messages: [], user_memories: [], user_settings: [] };
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
      result.forEach((r) => Object.assign(r, this.patch));
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
