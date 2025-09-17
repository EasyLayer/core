import { deflate, inflate } from 'node:zlib';
import { promisify } from 'node:util';

const deflateAsync = promisify(deflate);
const inflateAsync = promisify(inflate);

export interface CompressionToBuffer {
  buffer: Buffer; // compressed bytes (binary)
  originalSize: number;
  compressedSize: number;
  ratio: number; // originalSize / compressedSize
}

export class CompressionUtils {
  /** Heuristic: compress only if payload is large enough to matter. */
  static shouldCompress(json: string, minSize = 2048): boolean {
    return Buffer.byteLength(json, 'utf8') >= minSize;
  }

  /** Compress UTF-8 JSON → binary buffer (no base64 to avoid +33% overhead). */
  static async compressToBuffer(json: string): Promise<CompressionToBuffer> {
    const src = Buffer.from(json, 'utf8'); // one plain buffer (only here)
    const compressed = await deflateAsync(src);
    return {
      buffer: compressed,
      originalSize: src.length,
      compressedSize: compressed.length,
      ratio: src.length / compressed.length,
    };
  }

  /** Inflate binary buffer → UTF-8 JSON string. */
  static async decompressBufferToString(buf: Buffer): Promise<string> {
    const out = await inflateAsync(buf);
    return out.toString('utf8');
  }

  /**
   * Decompress “anything” → UTF-8 JSON string.
   * - Buffer: inflate directly
   * - string: try base64→inflate; if that fails — assume it's plain JSON
   */
  /* eslint-disable no-empty */
  static async decompressAny(data: Buffer | string): Promise<string> {
    if (Buffer.isBuffer(data)) {
      return await this.decompressBufferToString(data);
    }
    try {
      const maybe = Buffer.from(data, 'base64');
      if (maybe.length > 0) {
        return await this.decompressBufferToString(maybe);
      }
    } catch {}
    return data; // plain JSON string as-is
  }
  /* eslint-enable no-empty */
}
