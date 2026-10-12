// In-memory stand-in for the relay's data access. Its accounting mirrors the
// SQL functions (reserve / finalize / usage) so relay control flow can be tested.
// It does NOT prove the SQL itself is correct.
export class FakeRepo {
  constructor({ guestLimitUsed = 0, conversations = {}, history = {}, prefs = {} } = {}) {
    this.usage = new Map(); // requestId -> { subject, status }
    this.messages = []; // saved by the relay
    this.conversations = conversations; // userId -> Set(conversationId)
    this.history = history; // conversationId -> [{role, content, status}]
    this.prefs = prefs; // userId -> { depth, memories }
    this.rateCalls = [];
    this.rateAllowed = true;
    this.failOn = null;
    for (let i = 0; i < guestLimitUsed; i += 1) this.usage.set(`seed-${i}`, { subject: 'seed', status: 'completed' });
    this.seedSubject = null;
    this.calls = [];
  }
  subjectOf({ userId, guestSessionId }) {
    return userId ?? `guest:${guestSessionId}`;
  }
  countFor(subject) {
    let n = 0;
    for (const u of this.usage.values()) {
      if ((u.subject === subject || (u.subject === 'seed' && this.seedSubject === subject)) && ['reserved', 'completed', 'partial'].includes(u.status)) n += 1;
    }
    return n;
  }
  snapshot(args) {
    const used = this.countFor(this.subjectOf(args));
    return { used, limit: args.limit, remaining: Math.max(0, args.limit - used), resetsAt: args.userId ? '2026-10-12T00:00:00.000Z' : null };
  }
  async rateLimit(subject, seconds, max) {
    this.rateCalls.push([subject, seconds, max]);
    return this.rateAllowed;
  }
  async getConversation(userId, id) {
    return this.conversations[userId]?.has(id) ? { id } : null;
  }
  async reserveUsage({ requestId, userId, guestSessionId, limit }) {
    if (this.failOn === 'reserve') throw new Error('db down');
    await Promise.resolve(); // yield, like a real round trip
    const args = { userId, guestSessionId, limit };
    const subject = this.subjectOf(args);
    if (this.seedSubject === null) this.seedSubject = subject;
    if (this.usage.has(requestId)) return { allowed: false, duplicate: true, usage: this.snapshot(args) };
    if (this.countFor(subject) >= limit) return { allowed: false, usage: this.snapshot(args) };
    this.usage.set(requestId, { subject, status: 'reserved' });
    return { allowed: true, usage: this.snapshot(args) };
  }
  async finalizeUsage(requestId, status) {
    this.calls.push(['finalize', requestId, status]);
    this.usage.get(requestId).status = status;
  }
  async getUsage(args) {
    return this.snapshot(args);
  }
  async loadContext(userId, conversationId) {
    return this.history[conversationId] ?? [];
  }
  async loadPreferences(userId) {
    return this.prefs[userId] ?? { depth: 'balanced', memories: [] };
  }
  async saveUserMessage(m) {
    this.messages.push({ role: 'user', ...m });
  }
  async saveAssistantMessage(m) {
    if (this.failOn === 'saveAssistant') throw new Error('db down');
    this.messages.push({ role: 'assistant', ...m });
  }
}

export class FakeClientSocket {
  constructor() {
    this.sent = [];
    this.closed = null;
    this.onmessage = this.onclose = this.onerror = null;
  }
  send(data) {
    if (this.closed !== null) throw new Error('closed');
    this.sent.push(JSON.parse(data));
  }
  close(code) {
    this.closed = code;
  }
  receive(frame) {
    this.onmessage?.({ data: typeof frame === 'string' ? frame : JSON.stringify(frame) });
  }
  drop() {
    this.closed = 1006;
    this.onclose?.({});
  }
  get types() {
    return this.sent.map((f) => f.type);
  }
}
