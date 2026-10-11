// True when the scroll container is within `threshold` px of its bottom.
export function isNearBottom({ scrollTop, scrollHeight, clientHeight }, threshold = 80) {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}
