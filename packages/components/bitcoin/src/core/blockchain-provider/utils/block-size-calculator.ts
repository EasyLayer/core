import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import type { UniversalBlock, UniversalTransaction, NetworkConfig } from '../transports';

/**
 *
 * Design:
 * - For hex inputs use bitcoinjs to decode header/tx layout, but avoid heavy per-tx methods.
 * - Stripped size is computed structurally (no witness).
 * - For SegWit: weight = strippedSize*4 + witnessSize; vsize = ceil(weight/4).
 * - For Non-SegWit: weight = strippedSize*4; vsize = strippedSize.
 * - Provides consistent results without calling tx.weight()/virtualSize() in hot paths.
 */

export interface BlockSizeResult {
  size: number;
  strippedSize: number;
  weight: number;
  vsize: number;
  witnessSize?: number;
  headerSize: number;
  transactionsSize: number;
}

export interface TransactionSizeResult {
  size: number;
  strippedSize: number;
  vsize: number;
  weight: number;
  witnessSize?: number;
}

export class BlockSizeCalculator {
  static calculateSizeFromHex(hex: string, networkConfig: NetworkConfig): BlockSizeResult {
    if (!hex) throw new Error('Block hex is required for size calculation');

    const buffer = Buffer.from(hex, 'hex');
    const btcBlock = bitcoin.Block.fromBuffer(buffer);
    return this.calculateSizeFromBitcoinJSBlock(btcBlock, buffer, networkConfig);
  }

  static calculateSizeFromBlock(block: UniversalBlock, networkConfig: NetworkConfig): BlockSizeResult {
    if (block.hex) return this.calculateSizeFromHex(block.hex, networkConfig);

    if (block.tx && Array.isArray(block.tx) && block.tx.length > 0) {
      return this.calculateSizeFromTransactions(block.tx as (string | UniversalTransaction)[], networkConfig);
    }

    const size = block.size || 0;
    const strippedSize = block.strippedsize || size;
    const weight = block.weight || strippedSize * 4;
    const vsize = Math.ceil(weight / 4);
    const witnessSize = networkConfig.hasSegWit && size > strippedSize ? size - strippedSize : undefined;

    return {
      size,
      strippedSize,
      weight,
      vsize,
      witnessSize,
      headerSize: 80,
      transactionsSize: Math.max(0, size - 80),
    };
  }

  static calculateTransactionSizeFromHex(hex: string, networkConfig: NetworkConfig): TransactionSizeResult {
    if (!hex) throw new Error('Transaction hex is required for size calculation');

    const buffer = Buffer.from(hex, 'hex');
    const tx = bitcoin.Transaction.fromBuffer(buffer);
    return this.calculateTransactionSizeFromBitcoinJS(tx, networkConfig);
  }

  static calculateTransactionSize(tx: UniversalTransaction, networkConfig: NetworkConfig): TransactionSizeResult {
    if (tx.hex) return this.calculateTransactionSizeFromHex(tx.hex, networkConfig);

    const size = tx.size || 0;
    const weight = tx.weight || 0;
    const vsize = tx.vsize || Math.ceil(weight / 4);

    let strippedSize = size;
    let witnessSize: number | undefined;

    if (networkConfig.hasSegWit && weight > 0) {
      const estimatedBaseSize = Math.floor((weight + 3) / 4);
      strippedSize = Math.min(estimatedBaseSize, size);
      if (size > strippedSize) witnessSize = size - strippedSize;
    }

    return { size, strippedSize, vsize, weight, witnessSize };
  }

  private static calculateSizeFromBitcoinJSBlock(
    btcBlock: bitcoin.Block,
    buffer: Buffer,
    networkConfig: NetworkConfig
  ): BlockSizeResult {
    const size = buffer.length;
    const transactions = btcBlock.transactions || [];

    let strippedSize = 80;
    strippedSize += this.getVarintSize(transactions.length);
    for (const tx of transactions)
      strippedSize += this.calculateStrippedTransactionSize(tx as unknown as bitcoin.Transaction);

    let weight: number;
    let vsize: number;
    let witnessSize: number | undefined;

    if (networkConfig.hasSegWit) {
      witnessSize = size > strippedSize ? size - strippedSize : undefined;
      weight = strippedSize * 4 + (witnessSize ?? 0);
      vsize = Math.ceil(weight / 4);
    } else {
      weight = strippedSize * 4;
      vsize = strippedSize;
      witnessSize = undefined;
    }

    return {
      size,
      strippedSize,
      weight,
      vsize,
      witnessSize,
      headerSize: 80,
      transactionsSize: size - 80,
    };
  }

  private static calculateSizeFromTransactions(
    transactions: (string | UniversalTransaction)[],
    networkConfig: NetworkConfig
  ): BlockSizeResult {
    const headerSize = 80;
    const txCountSize = this.getVarintSize(transactions.length);

    let totalSize = headerSize + txCountSize;
    let totalStrippedSize = headerSize + txCountSize;
    let totalWeight = (headerSize + txCountSize) * 4;

    for (const tx of transactions) {
      if (typeof tx === 'string') {
        totalSize += 250;
        totalStrippedSize += 200;
        totalWeight += 1000;
      } else {
        const txSizes = this.calculateTransactionSize(tx, networkConfig);
        totalSize += txSizes.size;
        totalStrippedSize += txSizes.strippedSize;
        totalWeight += txSizes.weight;
      }
    }

    const vsize = Math.ceil(totalWeight / 4);
    const witnessSize =
      networkConfig.hasSegWit && totalSize > totalStrippedSize ? totalSize - totalStrippedSize : undefined;

    return {
      size: totalSize,
      strippedSize: totalStrippedSize,
      weight: totalWeight,
      vsize,
      witnessSize,
      headerSize,
      transactionsSize: totalSize - headerSize,
    };
  }

  /**
   * Public helper used by HexTransformer: derive tx sizes from a bitcoinjs Transaction.
   * Avoids expensive tx.weight()/virtualSize() by using strippedSize and simple formulas.
   */
  static calculateTransactionSizeFromBitcoinJS(
    tx: bitcoin.Transaction,
    networkConfig?: NetworkConfig
  ): TransactionSizeResult {
    const size = (tx as any).byteLength ? (tx as any).byteLength() : (tx as any).__byteLength ?? 0;
    const strippedSize = this.calculateStrippedTransactionSize(tx);

    let weight: number;
    let vsize: number;
    let witnessSize: number | undefined;

    if (networkConfig?.hasSegWit) {
      witnessSize = size > strippedSize ? size - strippedSize : undefined;
      weight = strippedSize * 4 + (witnessSize ?? 0);
      vsize = Math.ceil(weight / 4);
    } else {
      weight = strippedSize * 4;
      vsize = strippedSize;
      witnessSize = undefined;
    }

    return { size, strippedSize, vsize, weight, witnessSize };
  }

  /**
   * Stripped tx size from bitcoinjs Transaction shape (no witness data).
   */
  private static calculateStrippedTransactionSize(tx: bitcoin.Transaction): number {
    let size = 4;

    size += this.getVarintSize((tx as any).ins.length);
    for (const input of (tx as any).ins) {
      size += 32;
      size += 4;
      size += this.getVarintSize(input.script.length);
      size += input.script.length;
      size += 4;
    }

    size += this.getVarintSize((tx as any).outs.length);
    for (const output of (tx as any).outs) {
      size += 8;
      size += this.getVarintSize(output.script.length);
      size += output.script.length;
    }

    size += 4;
    return size;
  }

  private static getVarintSize(value: number): number {
    if (value < 0xfd) return 1;
    if (value <= 0xffff) return 3;
    if (value <= 0xffffffff) return 5;
    return 9;
  }

  static calculateBlockEfficiency(
    sizeResult: BlockSizeResult,
    networkConfig: NetworkConfig
  ): { sizeEfficiency: number; weightEfficiency: number; witnessDataRatio: number } {
    const sizeEfficiency = networkConfig.maxBlockSize > 0 ? (sizeResult.size / networkConfig.maxBlockSize) * 100 : 0;
    const weightEfficiency =
      networkConfig.maxBlockWeight > 0 ? (sizeResult.weight / networkConfig.maxBlockWeight) * 100 : 0;
    const witnessDataRatio =
      sizeResult.witnessSize && sizeResult.size > 0 ? (sizeResult.witnessSize / sizeResult.size) * 100 : 0;
    return { sizeEfficiency, weightEfficiency, witnessDataRatio };
  }

  static validateSizes(sizeResult: BlockSizeResult | TransactionSizeResult): boolean {
    if (sizeResult.size < 0 || sizeResult.strippedSize < 0 || sizeResult.weight < 0 || sizeResult.vsize < 0)
      return false;
    if (sizeResult.strippedSize > sizeResult.size) return false;
    if (sizeResult.weight < sizeResult.strippedSize * 4) return false;

    const expectedVsize = Math.ceil(sizeResult.weight / 4);
    if (Math.abs(sizeResult.vsize - expectedVsize) > 1) return false;

    if (sizeResult.witnessSize !== undefined) {
      const calculatedWitnessSize = sizeResult.size - sizeResult.strippedSize;
      if (Math.abs((sizeResult.witnessSize ?? 0) - calculatedWitnessSize) > 1) return false;
    }
    return true;
  }
}
