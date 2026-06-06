import * as bitcoin from 'bitcoinjs-lib';
import { asBufferView, reverseHexBE } from '../utils/buffer-view';

export interface RawBlockHeaderMetadata {
  hash: string;
  prevHash: string;
  size: number;
}

/**
 * Extract only block-header metadata without parsing transactions.
 * This is used before queue enqueue for P2P/ZMQ live blocks.
 */
export function extractRawBlockHeaderMetadata(bytes: Buffer | Uint8Array): RawBlockHeaderMetadata {
  if (!bytes || bytes.byteLength < 80) {
    throw new Error(`Raw block bytes must contain at least an 80-byte header, got ${bytes?.byteLength ?? 0}`);
  }

  const view = asBufferView(bytes);
  const header = view.subarray(0, 80);
  const hash = reverseHexBE(bitcoin.crypto.hash256(header));
  const prevHash = reverseHexBE(header.subarray(4, 36));

  return { hash, prevHash, size: view.length };
}
