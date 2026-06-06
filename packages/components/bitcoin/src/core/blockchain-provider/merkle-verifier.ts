import { hash as fastSha256 } from 'fast-sha256';
import { Buffer } from 'buffer';
import { BitcoinNativeRuntimeError, requireBitcoinNativeMerkleVerifier } from '../native';
import { asBufferView, reverseHexBE } from './utils/buffer-view';

/**
 * Fast Merkle utilities:
 * - Public runtime methods require the Rust native verifier in Node.js.
 * - Private JS helpers are kept only for local algorithm tests and browser/WASM parity work.
 * - Input txids/wtxids are BE hex (RPC style).
 * - Internally hashes use LE bytes; we reverse to LE up front.
 * - Each level: H(H(leftLE || rightLE)), odd leaves duplicate the last.
 * - Final root is returned as BE hex (RPC style).
 * - BIP141 witness commitment: H(H(witness_root_LE || reserved32)) embedded in coinbase.
 */
function hexBEtoBufLE(hexBE: string): Buffer {
  const buf = Buffer.from(hexBE, 'hex');
  for (let i = 0, j = buf.length - 1; i < j; i++, j--) {
    const t = buf[i];
    buf[i] = buf[j]!;
    buf[j] = t!;
  }
  return buf;
}

function bufLEtoHexBE(bufLE: Buffer): string {
  return reverseHexBE(bufLE);
}

function dsha256(buf: Buffer): Buffer {
  const h1 = fastSha256(buf);
  const h2 = fastSha256(h1);
  return asBufferView(h2);
}

function dsha256Pair(leftLE: Buffer, rightLE: Buffer, scratch64: Buffer): Buffer {
  leftLE.copy(scratch64, 0);
  rightLE.copy(scratch64, 32);
  return dsha256(scratch64);
}

function asNativeError(method: string, err: unknown): BitcoinNativeRuntimeError {
  if (err instanceof BitcoinNativeRuntimeError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new BitcoinNativeRuntimeError(`NativeMerkleVerifier.${method} failed: ${message}`);
}

export class BitcoinMerkleVerifier {
  /**
   * Compute Merkle root from BE txids. Single-tx case returns that txid.
   * Uses the Rust native verifier in Node.js; JavaScript fallback is disabled.
   */
  static computeMerkleRoot(txidsBE: string[]): string {
    try {
      return requireBitcoinNativeMerkleVerifier().bitcoinComputeMerkleRoot(txidsBE);
    } catch (err) {
      throw asNativeError('bitcoinComputeMerkleRoot', err);
    }
  }

  private static _computeMerkleRootJS(txidsBE: string[]): string {
    if (!txidsBE || txidsBE.length === 0) throw new Error('Cannot compute Merkle root from empty transaction list');
    if (txidsBE.length === 1) return txidsBE[0]!.toLowerCase();

    let cur = new Array<Buffer>(txidsBE.length);
    for (let i = 0; i < txidsBE.length; i++) cur[i] = hexBEtoBufLE(txidsBE[i]!);

    const scratch = Buffer.allocUnsafe(64);
    let next = new Array<Buffer>((cur.length + 1) >> 1);

    while (cur.length > 1) {
      let w = 0;
      for (let i = 0; i < cur.length; i += 2) {
        const left = cur[i]!;
        const right = cur[i + 1] ?? left;
        next[w++] = dsha256Pair(left, right, scratch);
      }
      next.length = w;
      const tmp = cur;
      cur = next;
      next = tmp;
    }

    return bufLEtoHexBE(cur[0]!).toLowerCase();
  }

  /**
   * Verify Merkle root equality. Uses Rust native verifier; no JS fallback.
   */
  static verifyMerkleRoot(txidsBE: string[], expectedRootBE: string): boolean {
    try {
      return requireBitcoinNativeMerkleVerifier().bitcoinVerifyMerkleRoot(txidsBE, expectedRootBE);
    } catch (err) {
      throw asNativeError('bitcoinVerifyMerkleRoot', err);
    }
  }

  /**
   * Compute witness Merkle root; coinbase wtxid is 32 zero bytes per BIP141.
   * Returns BE hex for RPC comparison.
   */
  static computeWitnessMerkleRoot(wtxidsBE: string[]): string {
    if (!wtxidsBE || wtxidsBE.length === 0)
      throw new Error('Cannot compute witness Merkle root from empty wtxids list');
    const ids = wtxidsBE.slice();
    ids[0] = '0'.repeat(64);
    return this.computeMerkleRoot(ids);
  }

  /**
   * Validate BIP141 witness commitment embedded in coinbase.
   * Uses Rust native verifier; no JS fallback.
   */
  static verifyWitnessCommitment(block: any): boolean {
    try {
      return requireBitcoinNativeMerkleVerifier().bitcoinVerifyWitnessCommitment(block);
    } catch (err) {
      throw asNativeError('bitcoinVerifyWitnessCommitment', err);
    }
  }

  private static _verifyWitnessCommitmentJS(block: any): boolean {
    try {
      if (!block?.tx?.length) return true;

      const commitmentHex = this.extractWitnessCommitmentFromCoinbase(block.tx[0]);
      if (!commitmentHex) return true;

      const extracted = this.extractWtxIds(block.tx);
      if (!extracted.length) return true;

      const wtxids = extracted.slice();
      const coinbase = block.tx[0];
      const coinbaseHasId =
        typeof coinbase === 'string' ? true : Boolean(coinbase?.wtxid ?? coinbase?.txid ?? coinbase?.hash);

      if (!coinbaseHasId) {
        wtxids.unshift('0'.repeat(64));
      }

      const witnessRootBE = this._computeMerkleRootJS(['0'.repeat(64), ...wtxids.slice(1)]);
      const witnessRootLE = hexBEtoBufLE(witnessRootBE);
      const reserved = this.extractWitnessReservedValue(block.tx[0]) ?? Buffer.alloc(32, 0x00);

      const calc = dsha256(Buffer.concat([witnessRootLE, reserved])).toString('hex');
      return calc.toLowerCase() === commitmentHex.toLowerCase();
    } catch {
      return false;
    }
  }

  /**
   * Extract txids (BE hex) from mixed string/object arrays. Lower-cases for stable compare.
   */
  static extractTxIds(transactions: any[]): string[] {
    return (transactions ?? [])
      .map((tx) => (typeof tx === 'string' ? tx : tx?.txid ?? tx?.hash))
      .filter(Boolean)
      .map((s: string) => s.toLowerCase());
  }

  /**
   * Extract wtxids (BE hex), falling back to txid/hash if wtxid is missing.
   */
  static extractWtxIds(transactions: any[]): string[] {
    return (transactions ?? [])
      .map((tx) => (typeof tx === 'string' ? tx : tx?.wtxid ?? tx?.txid ?? tx?.hash))
      .filter(Boolean)
      .map((s: string) => s.toLowerCase());
  }

  /**
   * Verify full block merkleroot, optionally checking witness commitment if tx objects exist.
   */
  static verifyBlockMerkleRoot(block: any, verifyWitness = false): boolean {
    try {
      if (!block?.merkleroot) return false;

      const txids = this.extractTxIds(block.tx ?? []);
      if (txids.length === 0) return block.merkleroot === '0'.repeat(64);

      if (!this.verifyMerkleRoot(txids, block.merkleroot)) return false;

      if (verifyWitness && (block.tx?.length ?? 0) > 0) {
        const hasObjects = block.tx.some((tx: any) => typeof tx === 'object');
        if (hasObjects) return this.verifyWitnessCommitment(block);
      }
      return true;
    } catch (err) {
      if (err instanceof BitcoinNativeRuntimeError) throw err;
      return false;
    }
  }

  /**
   * Genesis helper: at height 0 with exactly one tx, merkleroot must equal that txid (both BE).
   */
  static verifyGenesisMerkleRoot(block: any): boolean {
    try {
      if (!block || block.height !== 0) throw new Error('Not a genesis block');
      if (!block.merkleroot) return false;
      const txids = this.extractTxIds(block.tx ?? []);
      if (txids.length !== 1) return false;
      return block.merkleroot.toLowerCase() === txids[0]!.toLowerCase();
    } catch {
      return false;
    }
  }

  private static extractWitnessCommitmentFromCoinbase(coinbaseTx: any): string | null {
    for (const vout of coinbaseTx?.vout ?? []) {
      const script: string | undefined = vout?.scriptPubKey?.hex;
      if (script?.startsWith('6a24aa21a9ed') && script.length >= 12 + 64) {
        return script.slice(12, 12 + 64);
      }
    }
    return null;
  }

  private static extractWitnessReservedValue(coinbaseTx: any): Buffer | null {
    const w = coinbaseTx?.vin?.[0]?.txinwitness;
    if (!Array.isArray(w)) return null;
    for (let i = w.length - 1; i >= 0; i--) {
      const item = w[i];
      if (typeof item === 'string' && item.length === 64) {
        return Buffer.from(item, 'hex');
      }
    }
    return null;
  }

  static getEmptyMerkleRoot(): string {
    return '0'.repeat(64);
  }
}
