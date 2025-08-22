import { deflate, inflate } from 'node:zlib';
import { promisify } from 'node:util';

const deflateAsync = promisify(deflate);
const inflateAsync = promisify(inflate);

export interface CompressionResult {
  data: string; // base64 string (for string-storage columns)
  originalSize: number;
  compressedSize: number;
  compressionRatio: number;
}

export class CompressionUtils {
  /**
   * Compress UTF-8 JSON string with DEFLATE, return base64 for storage in TEXT columns.
   */
  static async compress(data: string): Promise<CompressionResult> {
    const originalBuffer = Buffer.from(data, 'utf8');
    const compressedBuffer = await deflateAsync(originalBuffer);
    return {
      data: compressedBuffer.toString('base64'),
      originalSize: originalBuffer.length,
      compressedSize: compressedBuffer.length,
      compressionRatio: originalBuffer.length / compressedBuffer.length,
    };
  }

  /**
   * Decompress from base64-encoded DEFLATE (legacy path for TEXT storage).
   */
  static async decompress(compressedDataBase64: string): Promise<string> {
    const compressedBuffer = Buffer.from(compressedDataBase64, 'base64');
    const decompressedBuffer = await inflateAsync(compressedBuffer);
    return decompressedBuffer.toString('utf8');
  }

  /**
   * Decompress when input can be Buffer (binary `bytea`/`blob`) OR base64 string.
   * This is the MAIN method to use on the outbox read path.
   */
  static async decompressAny(input: Buffer | string): Promise<string> {
    const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'base64');
    const decompressed = await inflateAsync(buf);
    return decompressed.toString('utf8');
  }

  /**
   * Decompress+parse JSON in one step (base64 string input, legacy).
   */
  static async decompressAndParse<T = any>(compressedDataBase64: string): Promise<T> {
    const decompressedString = await this.decompress(compressedDataBase64);
    return JSON.parse(decompressedString);
  }

  static shouldCompress(data: string): boolean {
    if (data.length < 1000) return false;
    if (data.length > 100000) return true;
    // simple heuristic
    return true;
  }

  static async safeDecompressAny(input: Buffer | string, fallbackUtf8?: string): Promise<string> {
    try {
      return await this.decompressAny(input);
    } catch {
      return fallbackUtf8 ?? (Buffer.isBuffer(input) ? input.toString('utf8') : input);
    }
  }
}

export class CompressionMetrics {
  private static metrics = {
    totalCompressions: 0,
    totalDecompressions: 0,
    totalBytesSaved: 0,
    totalCompressionTime: 0,
    totalDecompressionTime: 0,
    errors: 0,
  };

  static recordCompression(result: CompressionResult, timeMs: number) {
    this.metrics.totalCompressions++;
    this.metrics.totalBytesSaved += result.originalSize - result.compressedSize;
    this.metrics.totalCompressionTime += timeMs;
  }

  static recordDecompression(timeMs: number) {
    this.metrics.totalDecompressions++;
    this.metrics.totalDecompressionTime += timeMs;
  }

  static recordError() {
    this.metrics.errors++;
  }

  static getMetrics() {
    return {
      ...this.metrics,
      avgCompressionTime:
        this.metrics.totalCompressions > 0 ? this.metrics.totalCompressionTime / this.metrics.totalCompressions : 0,
      avgDecompressionTime:
        this.metrics.totalDecompressions > 0
          ? this.metrics.totalDecompressionTime / this.metrics.totalDecompressions
          : 0,
      avgBytesSavedPerCompression:
        this.metrics.totalCompressions > 0 ? this.metrics.totalBytesSaved / this.metrics.totalCompressions : 0,
    };
  }

  static reset() {
    this.metrics = {
      totalCompressions: 0,
      totalDecompressions: 0,
      totalBytesSaved: 0,
      totalCompressionTime: 0,
      totalDecompressionTime: 0,
      errors: 0,
    };
  }
}
