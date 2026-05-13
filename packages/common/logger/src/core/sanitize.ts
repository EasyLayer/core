const REDACTED = '[REDACTED]';
const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 200;
const MAX_OBJECT_KEYS = 200;
const MAX_STRING_LENGTH = 8_192;

const SENSITIVE_KEY_PATTERN =
  /(?:password|passwd|pwd|secret|token|access[_-]?key|api[_-]?key|private[_-]?key|authorization|auth|cookie|session|jwt)/i;

export function sanitizeLogValue(value: unknown): unknown {
  return sanitize(value, 0, new WeakSet<object>(), '');
}

function sanitize(value: unknown, depth: number, seen: WeakSet<object>, key: string): unknown {
  if (SENSITIVE_KEY_PATTERN.test(key)) return REDACTED;

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: truncateString(value.stack),
    };
  }

  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return truncateString(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value;
  if (typeof value === 'function') return value.name ? `[Function:${value.name}]` : '[Function]';
  if (typeof value !== 'object') return String(value);

  if (seen.has(value as object)) return '[Circular]';
  if (depth >= MAX_DEPTH) return '[MaxDepth]';
  seen.add(value as object);

  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_ARRAY_ITEMS).map((item, index) => sanitize(item, depth + 1, seen, String(index)));
    if (value.length > MAX_ARRAY_ITEMS) out.push(`[Truncated:${value.length - MAX_ARRAY_ITEMS}]`);
    seen.delete(value as object);
    return out;
  }

  const out: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [entryKey, entryValue] of entries.slice(0, MAX_OBJECT_KEYS)) {
    out[entryKey] = sanitize(entryValue, depth + 1, seen, entryKey);
  }
  if (entries.length > MAX_OBJECT_KEYS) out.__truncatedKeys = entries.length - MAX_OBJECT_KEYS;

  seen.delete(value as object);
  return out;
}

function truncateString(value: string | undefined): string | undefined {
  if (value == null) return value;
  if (value.length <= MAX_STRING_LENGTH) return value;
  return `${value.slice(0, MAX_STRING_LENGTH)}...[truncated:${value.length - MAX_STRING_LENGTH}]`;
}
