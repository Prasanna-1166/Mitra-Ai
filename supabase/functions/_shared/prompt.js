// Builds the single `message` string sent to the provider: bounded recent
// conversation context followed by the current question. Only supported
// provider fields (chatId, appId, systemPrompt, message) are ever used.

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);

// history: [{ role, content, status? }] oldest first, NOT including the new message.
export function selectContext(history, { maxMessages = 20, maxChars = 12000, maxTurnChars = 3000 } = {}) {
  const usable = history.filter((m) => {
    if (!m || typeof m.content !== 'string' || !m.content.trim()) return false;
    if (m.role === 'assistant') return !m.status || m.status === 'complete'; // never feed back partial or failed replies
    return m.role === 'user';
  });
  const picked = [];
  let chars = 0;
  for (let i = usable.length - 1; i >= 0 && picked.length < maxMessages; i -= 1) {
    const text = clip(usable[i].content.trim(), maxTurnChars);
    if (picked.length > 0 && chars + text.length > maxChars) break;
    picked.unshift({ role: usable[i].role, content: text });
    chars += text.length;
  }
  return picked;
}

export function buildUpstreamMessage({ history = [], message, limits }) {
  const context = selectContext(history, limits);
  if (context.length === 0) return message;
  const transcript = context
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n');
  return [
    'Earlier in this conversation (oldest first):',
    transcript,
    '',
    'Current message from the user (answer this one, using the conversation above as context):',
    message,
  ].join('\n');
}
