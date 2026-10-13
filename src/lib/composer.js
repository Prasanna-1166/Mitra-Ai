// Enter sends, Shift+Enter inserts a newline. Enter pressed while an input
// method editor (IME) is composing text must NOT send.
export function isSendKey(event) {
  if (event.key !== 'Enter') return false;
  if (event.shiftKey) return false;
  if (event.isComposing || event.keyCode === 229) return false;
  return true;
}
