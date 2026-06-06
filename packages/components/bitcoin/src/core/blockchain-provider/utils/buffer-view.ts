import { Buffer } from 'buffer';

/**
 * Return a Buffer view over an existing byte range.
 *
 * Use this helper only for read-only paths where the producer owns the bytes for
 * the whole synchronous operation and the consumer must not mutate them. This is
 * intentionally different from copyBuffer(): it does not create an ownership
 * snapshot.
 */
export function asBufferView(bytes: Buffer | Uint8Array | ArrayBuffer): Buffer {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * Create an explicit ownership snapshot.
 *
 * Use across async/lifetime boundaries, when the producer may reuse/mutate its
 * buffer, or when mutation of the returned Buffer is intentional. This helper is
 * deliberately named so copies in hot paths are visible during review.
 */
export function copyBuffer(bytes: Buffer | Uint8Array | ArrayBuffer): Buffer {
  return Buffer.from(asBufferView(bytes));
}

/**
 * Render bytes in reverse order as hex without first copying and mutating a
 * Buffer. Useful for Bitcoin little-endian internal hashes that must be exposed
 * as RPC-style big-endian hex strings.
 */
export function reverseHexBE(bytes: Buffer | Uint8Array): string {
  const hex = new Array<string>(bytes.length);
  for (let i = bytes.length - 1, out = 0; i >= 0; i -= 1, out += 1) {
    hex[out] = bytes[i]!.toString(16).padStart(2, '0');
  }
  return hex.join('');
}
