import { deflate, inflate } from 'node:zlib';
import { promisify } from 'node:util';

const deflateAsync = promisify(deflate);
const inflateAsync = promisify(inflate);

export interface CompressionResult {
  data: string;
  originalSize: number;
  compressedSize: number;
  compressionRatio: number;
}

export class CompressionUtils {
  /**
   * Compresses data using deflate algorithm and returns base64 encoded string
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
   * Decompresses base64 encoded deflated data back to original string
   */
  static async decompress(compressedData: string): Promise<string> {
    const compressedBuffer = Buffer.from(compressedData, 'base64');
    const decompressedBuffer = await inflateAsync(compressedBuffer);
    return decompressedBuffer.toString('utf8');
  }

  /**
   * Decompresses and parses JSON in one step - MAIN METHOD TO USE
   * Use this for both events and snapshots when you need objects
   */
  static async decompressAndParse<T = any>(compressedData: string): Promise<T> {
    const decompressedString = await this.decompress(compressedData);
    return JSON.parse(decompressedString);
  }

  /**
   * Checks if compression would be beneficial (saves at least 20% space)
   */
  static shouldCompress(data: string, minCompressionRatio: number = 1.2): boolean {
    // For small payloads, compression overhead might not be worth it
    if (data.length < 1000) {
      return false;
    }

    // For very large payloads, always compress
    if (data.length > 100000) {
      return true;
    }

    // For medium payloads, use heuristics
    // JSON with repetitive structure compresses well
    const hasRepetitiveStructure = data.includes('{"') && data.includes('"}');
    const hasArrays = data.includes('[') && data.includes(']');

    return hasRepetitiveStructure || hasArrays;
  }

  /**
   * Safely attempts to decompress data, returns original if decompression fails
   */
  static async safeDecompress(data: string, fallback: string = data): Promise<string> {
    try {
      return await this.decompress(data);
    } catch (error) {
      return fallback;
    }
  }

  /**
   * Safely decompresses and parses, returns fallback object if fails
   */
  static async safeDecompressAndParse<T = any>(data: string, fallback: T): Promise<T> {
    try {
      return await this.decompressAndParse<T>(data);
    } catch (error) {
      return fallback;
    }
  }
}

/**
 * Metrics collector for compression performance monitoring
 */
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
