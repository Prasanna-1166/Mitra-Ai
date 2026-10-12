// Memory helpers shared by the browser (suggestions, validation) and the relay
// (selection for a request). Pure functions, no I/O.

export const MEMORY_MAX_CHARS = 500;
export const MEMORY_CATEGORIES = ['preference', 'project', 'tool', 'fact', 'other'];

export function sanitizeMemoryText(text) {
  if (typeof text !== 'string') return '';
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .replace(/[<>]/g, '') // memories are fenced; keep angle brackets out of them
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MEMORY_MAX_CHARS)
  );
}

function luhn(digits) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{8,}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:password|passwd|pwd|passcode|secret|token|api[ _-]?key|private[ _-]?key)\b\s*(?:is|are|was|=|:)\s*\S+/i,
  /\b\d{3}-\d{2}-\d{4}\b/, // US SSN shape
  /\b[A-Fa-f0-9]{32,}\b/, // long hex strings (keys, hashes)
  /\b[A-Za-z0-9+/_-]{40,}={0,2}(?![A-Za-z0-9])/, // long opaque tokens
];

// Heuristic only: it blocks obvious credentials and identifiers, it cannot
// recognise every sensitive detail.
export function looksSensitive(text) {
  if (typeof text !== 'string') return false;
  if (SECRET_PATTERNS.some((re) => re.test(text))) return true;
  const cardCandidates = text.match(/\b(?:\d[ -]?){13,19}\b/g) ?? [];
  return cardCandidates.some((c) => luhn(c.replace(/\D/g, '')));
}

// "Remember that I use TypeScript" -> "I use TypeScript"
const EXPLICIT = [
  /^\s*(?:please\s+)?remember(?:\s*[:,-]\s*|\s+(?:that\s+|this\s*[:,-]?\s*)?)(.+)$/is,
  /^\s*(?:please\s+)?(?:don'?t|do not)\s+forget\s+(?:that\s+)?(.+)$/is,
  /^\s*(?:please\s+)?(?:save|add|store)\s+(?:this\s+)?(?:to|in)\s+(?:my\s+)?memory\s*[:,-]?\s*(.+)$/is,
];

export function extractExplicitMemory(message) {
  if (typeof message !== 'string') return null;
  const firstParagraph = message.trim().split(/\n\s*\n/)[0];
  for (const re of EXPLICIT) {
    const m = re.exec(firstParagraph);
    if (m) {
      const text = sanitizeMemoryText(m[1].replace(/[.!\s]+$/, ''));
      if (text.length >= 3) return text;
    }
  }
  return null;
}

export function guessCategory(text) {
  if (/\b(prefer|always|usually|concise|detailed|brief|simply|step by step|format|tone|language)\b/i.test(text)) return 'preference';
  if (/\b(project|app|startup|building|working on|team|company|course|thesis)\b/i.test(text)) return 'project';
  if (/\b(use|using|stack|tool|editor|framework|library|vite|react|python|typescript|node)\b/i.test(text)) return 'tool';
  return 'fact';
}

// Conservative: only first-person statements about lasting preferences or work.
const SUGGEST = [
  /\b(?:i|i'd)\s+(?:really\s+)?(?:prefer|always use|usually use|mostly use|like to use|work with)\b[^.!?\n]{3,160}/i,
  /\bi(?:'m| am)\s+(?:currently\s+)?(?:working on|building|learning)\b[^.!?\n]{3,160}/i,
  /\bmy (?:project|app|startup|team|stack|favou?rite [a-z ]{2,20}) (?:is|are)\b[^.!?\n]{3,160}/i,
  /\b(?:explain|answer|reply|respond)\b[^.!?\n]{0,40}\b(?:more )?(?:simply|briefly|concisely|in detail|step by step)\b[^.!?\n]{0,60}\b(?:from now on|always|in future)\b[^.!?\n]*/i,
];

export function suggestMemory(message) {
  if (typeof message !== 'string' || extractExplicitMemory(message)) return null;
  for (const re of SUGGEST) {
    const m = re.exec(message);
    if (m) {
      const text = sanitizeMemoryText(m[0]);
      if (text.length >= 8 && !looksSensitive(text)) return text;
    }
  }
  return null;
}

const STOP = new Set(
  'the and for are but not you your with this that have has had was were what when where which who how why can could would should about from into over under then than them they their there here just like some any all out one two use using used get got make made want need please help also very more most much many other another being been does did doing done its it\'s our ours his her she him'.split(
    ' ',
  ),
);

const tokens = (s) =>
  (s.toLowerCase().match(/[\p{L}\p{N}+#.]{3,}/gu) ?? []).filter((t) => !STOP.has(t));

// Pick the memories worth sending: broadly useful preferences plus anything that
// overlaps with the current question, bounded by item count and total size.
export function selectRelevantMemories(memories, query, { maxItems = 12, maxChars = 2000 } = {}) {
  const queryTokens = new Set(tokens(query ?? ''));
  const scored = memories
    .filter((m) => m && m.enabled !== false && typeof m.content === 'string' && m.content.trim())
    .map((m, index) => {
      const words = tokens(m.content);
      const overlap = words.filter((w) => queryTokens.has(w)).length;
      const isPreference = m.category === 'preference';
      return { m, overlap, isPreference, index, score: overlap * 2 + (isPreference ? 1 : 0) };
    })
    // preferences apply broadly; others need some topical overlap
    .filter((s) => s.overlap > 0 || s.isPreference)
    .sort((a, b) => b.score - a.score || a.index - b.index);

  const chosen = [];
  let chars = 0;
  for (const { m } of scored) {
    const text = sanitizeMemoryText(m.content);
    if (!text || looksSensitive(text)) continue;
    if (chosen.length >= maxItems || chars + text.length > maxChars) continue;
    chosen.push(text);
    chars += text.length;
  }
  return chosen;
}
