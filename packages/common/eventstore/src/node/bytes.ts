export type Binary = Buffer | Uint8Array;

// Convert UTF-8 string → Buffer
export function utf8ToBuffer(s: string): Buffer {
  return Buffer.from(s, 'utf8');
}

// Convert Buffer/Uint8Array → UTF-8 string
export function bufferToUtf8(b: Binary): string {
  return Buffer.isBuffer(b) ? b.toString('utf8') : Buffer.from(b).toString('utf8');
}

// Exact byte length of a UTF-8 string
export function byteLengthUtf8(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}
