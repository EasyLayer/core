import { Buffer } from 'node:buffer';
import * as bitcoin from 'bitcoinjs-lib';
import type { UniversalBlock, UniversalTransaction, NetworkConfig } from '../node-providers';

/**
 * Size calculation result for blocks
 */
export interface BlockSizeResult {
  size: number; // Full block size including witness data
  strippedSize: number; // Size WITHOUT witness data
  weight: number; // Block weight (BIP 141)
  vsize: number; // Virtual block size
  witnessSize?: number; // Size of witness data only
  headerSize: number; // Block header size (always 80 bytes)
  transactionsSize: number; // Size of all transactions
}

/**
 * Size calculation result for transactions
 */
export interface TransactionSizeResult {
  size: number; // Full transaction size including witness data
  strippedSize: number; // Size WITHOUT witness data (base size)
  vsize: number; // Virtual transaction size
  weight: number; // Transaction weight (BIP 141)
  witnessSize?: number; // Size of witness data only
}

/**
 * Utility class for accurate Bitcoin block and transaction size calculations
 * Handles both SegWit and non-SegWit networks correctly
 */
export class BlockSizeCalculator {
  /**
   * Calculate accurate block sizes from hex data
   */
  static calculateSizeFromHex(hex: string, networkConfig: NetworkConfig): BlockSizeResult {
    if (!hex) {
      throw new Error('Block hex is required for size calculation');
    }

    const buffer = Buffer.from(hex, 'hex');
    const btcBlock = bitcoin.Block.fromBuffer(buffer);

    return this.calculateSizeFromBitcoinJSBlock(btcBlock, buffer, networkConfig);
  }

  /**
   * Calculate block sizes from Universal block object with transactions
   */
  static calculateSizeFromBlock(block: UniversalBlock, networkConfig: NetworkConfig): BlockSizeResult {
    // If we have hex data, use that for most accurate calculation
    if (block.hex) {
      return this.calculateSizeFromHex(block.hex, networkConfig);
    }

    // If we have transaction objects, calculate from them
    if (block.tx && Array.isArray(block.tx) && block.tx.length > 0) {
      return this.calculateSizeFromTransactions(block.tx, networkConfig);
    }

    // Fallback: use existing size fields if available
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

  /**
   * Calculate transaction sizes from hex data
   */
  static calculateTransactionSizeFromHex(hex: string, networkConfig: NetworkConfig): TransactionSizeResult {
    if (!hex) {
      throw new Error('Transaction hex is required for size calculation');
    }

    const buffer = Buffer.from(hex, 'hex');
    const tx = bitcoin.Transaction.fromBuffer(buffer);

    return this.calculateTransactionSizeFromBitcoinJS(tx, networkConfig);
  }

  /**
   * Calculate transaction sizes from Universal transaction object
   */
  static calculateTransactionSize(tx: UniversalTransaction, networkConfig: NetworkConfig): TransactionSizeResult {
    // If we have hex data, use that for most accurate calculation
    if (tx.hex) {
      return this.calculateTransactionSizeFromHex(tx.hex, networkConfig);
    }

    // Calculate from transaction structure
    const size = tx.size || 0;
    const weight = tx.weight || 0;
    const vsize = tx.vsize || Math.ceil(weight / 4);

    let strippedSize = size;
    let witnessSize: number | undefined;

    if (networkConfig.hasSegWit && weight > 0) {
      // Estimate stripped size from weight
      // Weight = (base_size * 4) + witness_size
      // So: base_size ≈ (weight - witness_size) / 4
      // We approximate: base_size ≈ weight / 4 (assuming minimal witness)
      const estimatedBaseSize = Math.floor((weight + 3) / 4);
      strippedSize = Math.min(estimatedBaseSize, size);

      if (size > strippedSize) {
        witnessSize = size - strippedSize;
      }
    }

    return {
      size,
      strippedSize,
      vsize,
      weight,
      witnessSize,
    };
  }

  /**
   * Calculate block sizes from bitcoinjs-lib Block object
   */
  private static calculateSizeFromBitcoinJSBlock(
    btcBlock: bitcoin.Block,
    buffer: Buffer,
    networkConfig: NetworkConfig
  ): BlockSizeResult {
    const size = buffer.length;
    const transactions = btcBlock.transactions || [];

    // Calculate stripped size (without witness data)
    let strippedSize = 80; // Block header
    strippedSize += this.getVarintSize(transactions.length); // Transaction count

    for (const tx of transactions) {
      strippedSize += this.calculateStrippedTransactionSize(tx);
    }

    let weight: number;
    let vsize: number;
    let witnessSize: number | undefined;

    if (networkConfig.hasSegWit) {
      // Calculate weight: (base_data * 4) + witness_data
      weight = 80 * 4; // Header weight
      weight += this.getVarintSize(transactions.length) * 4; // Transaction count weight

      for (const tx of transactions) {
        weight += tx.weight();
      }

      vsize = Math.ceil(weight / 4);

      // Calculate witness size
      if (size > strippedSize) {
        witnessSize = size - strippedSize;
      }
    } else {
      // Non-SegWit: weight = size * 4
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

  /**
   * Calculate block sizes from array of transactions
   */
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
        // We only have txid, can't calculate accurate sizes
        // Make rough estimates
        totalSize += 250; // Average transaction size
        totalStrippedSize += 200; // Average stripped size
        totalWeight += 1000; // Average weight
      } else {
        // We have full transaction object
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
   * Calculate transaction sizes from bitcoinjs-lib Transaction object
   * Public method used by HexTransformer
   */
  static calculateTransactionSizeFromBitcoinJS(
    tx: bitcoin.Transaction,
    networkConfig?: NetworkConfig
  ): TransactionSizeResult {
    const size = tx.byteLength();
    const strippedSize = this.calculateStrippedTransactionSize(tx);

    let weight: number;
    let vsize: number;
    let witnessSize: number | undefined;

    if (networkConfig?.hasSegWit) {
      weight = tx.weight();
      vsize = tx.virtualSize();

      if (size > strippedSize) {
        witnessSize = size - strippedSize;
      }
    } else {
      weight = strippedSize * 4;
      vsize = strippedSize;
      witnessSize = undefined;
    }

    return {
      size,
      strippedSize,
      vsize,
      weight,
      witnessSize,
    };
  }

  /**
   * Calculate stripped transaction size (without witness data)
   */
  private static calculateStrippedTransactionSize(tx: bitcoin.Transaction): number {
    let size = 4; // version (4 bytes)

    // Input count + inputs
    size += this.getVarintSize(tx.ins.length);
    for (const input of tx.ins) {
      size += 32; // previous output hash
      size += 4; // previous output index
      size += this.getVarintSize(input.script.length);
      size += input.script.length;
      size += 4; // sequence
    }

    // Output count + outputs
    size += this.getVarintSize(tx.outs.length);
    for (const output of tx.outs) {
      size += 8; // value (8 bytes)
      size += this.getVarintSize(output.script.length);
      size += output.script.length;
    }

    size += 4; // locktime (4 bytes)

    return size;
  }

  /**
   * Calculate the size of a variable-length integer
   */
  private static getVarintSize(value: number): number {
    if (value < 0xfd) return 1;
    if (value <= 0xffff) return 3;
    if (value <= 0xffffffff) return 5;
    return 9;
  }

  /**
   * Estimate block efficiency metrics
   */
  static calculateBlockEfficiency(
    sizeResult: BlockSizeResult,
    networkConfig: NetworkConfig
  ): {
    sizeEfficiency: number; // Percentage of max block size used
    weightEfficiency: number; // Percentage of max block weight used
    witnessDataRatio: number; // Percentage of block that is witness data
  } {
    const sizeEfficiency = networkConfig.maxBlockSize > 0 ? (sizeResult.size / networkConfig.maxBlockSize) * 100 : 0;

    const weightEfficiency =
      networkConfig.maxBlockWeight > 0 ? (sizeResult.weight / networkConfig.maxBlockWeight) * 100 : 0;

    const witnessDataRatio =
      sizeResult.witnessSize && sizeResult.size > 0 ? (sizeResult.witnessSize / sizeResult.size) * 100 : 0;

    return {
      sizeEfficiency,
      weightEfficiency,
      witnessDataRatio,
    };
  }

  /**
   * Validate calculated sizes for consistency
   */
  static validateSizes(sizeResult: BlockSizeResult | TransactionSizeResult): boolean {
    // Basic validation checks
    if (sizeResult.size < 0 || sizeResult.strippedSize < 0 || sizeResult.weight < 0 || sizeResult.vsize < 0) {
      return false;
    }

    // Stripped size should not be larger than total size
    if (sizeResult.strippedSize > sizeResult.size) {
      return false;
    }

    // Weight should be at least 4 times the stripped size
    if (sizeResult.weight < sizeResult.strippedSize * 4) {
      return false;
    }

    // Virtual size should be approximately weight / 4
    const expectedVsize = Math.ceil(sizeResult.weight / 4);
    if (Math.abs(sizeResult.vsize - expectedVsize) > 1) {
      return false;
    }

    // If witness size is present, it should equal total - stripped
    if (sizeResult.witnessSize !== undefined) {
      const calculatedWitnessSize = sizeResult.size - sizeResult.strippedSize;
      if (Math.abs(sizeResult.witnessSize - calculatedWitnessSize) > 1) {
        return false;
      }
    }

    return true;
  }
}
