import type { Buffer } from 'buffer';

export type Binary = Buffer | Uint8Array;

// Convert UTF-8 string → Uint8Array (cast to Buffer type for API parity)
export function utf8ToBuffer(s: string): Buffer {
  const u8 = new TextEncoder().encode(s);

  const B: any = (globalThis as any).Buffer;
  return B?.from ? B.from(u8) : (u8 as unknown as Buffer);
}

// Convert Buffer/Uint8Array → UTF-8 string
export function bufferToUtf8(b: Binary): string {
  const u8 =
    b instanceof Uint8Array ? b : new Uint8Array((b as any).buffer, (b as any).byteOffset, (b as any).byteLength);
  return new TextDecoder().decode(u8);
}

// Exact byte length of a UTF-8 string
export function byteLengthUtf8(s: string): number {
  return new TextEncoder().encode(s).length;
}
