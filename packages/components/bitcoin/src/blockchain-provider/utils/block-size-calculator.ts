import { Buffer } from 'node:buffer';
import * as bitcoin from 'bitcoinjs-lib';
import type { Block, Transaction } from '../components';
import type { NetworkConfig } from '../node-providers';

/**
 * Network-aware utility class for calculating accurate block and transaction sizes
 */
export class BlockSizeCalculator {
  /**
   * Calculate total block size from hex data
   */
  static calculateSizeFromHex(
    hex: string,
    networkConfig?: NetworkConfig
  ): {
    size: number;
    strippedSize: number;
    weight: number;
    vsize: number;
    witnessSize: number;
    headerSize: number;
    transactionsSize: number;
  } {
    if (!hex) {
      return this.createEmptyResult();
    }

    try {
      const buffer = Buffer.from(hex, 'hex');
      const block = bitcoin.Block.fromBuffer(buffer);

      const size = buffer.length;
      const headerSize = 80; // Block header is always 80 bytes for all Bitcoin-like networks

      let strippedSize = headerSize;
      let weight = headerSize * 4;
      let witnessSize = 0;

      if (block.transactions) {
        // Add transaction count varint
        const txCountSize = this.getVarintSize(block.transactions.length);
        strippedSize += txCountSize;
        weight += txCountSize * 4;

        // Calculate each transaction
        for (const tx of block.transactions) {
          const txStrippedSize = this.calculateTransactionStrippedSize(tx);
          strippedSize += txStrippedSize;

          if (networkConfig?.hasSegWit) {
            // Only calculate weight if network supports SegWit
            weight += tx.weight();
            const txWitnessSize = tx.weight() - txStrippedSize * 4;
            witnessSize += Math.max(0, txWitnessSize);
          } else {
            // For non-SegWit networks, weight = size * 4
            weight += txStrippedSize * 4;
          }
        }
      }

      const vsize = networkConfig?.hasSegWit ? Math.ceil(weight / 4) : strippedSize;
      const transactionsSize = size - headerSize;

      return {
        size,
        strippedSize,
        weight,
        vsize,
        witnessSize: networkConfig?.hasSegWit ? witnessSize : 0,
        headerSize,
        transactionsSize,
      };
    } catch (error) {
      throw new Error(`Failed to calculate block size from hex: ${error}`);
    }
  }

  /**
   * Calculate total block size from block object with transactions
   */
  static calculateSizeFromBlock(
    block: Block,
    networkConfig?: NetworkConfig
  ): {
    size: number;
    strippedSize: number;
    weight: number;
    vsize: number;
    witnessSize: number;
    headerSize: number;
    transactionsSize: number;
  } {
    if (!block.tx || block.tx.length === 0) {
      // Use existing values if transactions are not available
      const witnessSize = networkConfig?.hasSegWit ? Math.max(0, block.size - block.strippedsize) : 0;
      return {
        size: block.size || 0,
        strippedSize: block.strippedsize || 0,
        weight: block.weight || 0,
        vsize: block.vsize || Math.ceil((block.weight || 0) / 4),
        witnessSize,
        headerSize: 80,
        transactionsSize: (block.size || 0) - 80,
      };
    }

    // Calculate from transactions
    const headerSize = 80;
    const transactionCountSize = this.getVarintSize(block.tx.length);
    let totalSize = headerSize + transactionCountSize;
    let totalStrippedSize = headerSize + transactionCountSize;
    let totalWeight = (headerSize + transactionCountSize) * 4;
    let totalWitnessSize = 0;

    // Calculate each transaction
    for (const tx of block.tx) {
      const txSizes = this.calculateTransactionSize(tx, networkConfig);
      totalSize += txSizes.size;
      totalStrippedSize += txSizes.strippedSize;
      totalWeight += txSizes.weight;

      if (networkConfig?.hasSegWit) {
        totalWitnessSize += txSizes.witnessSize;
      }
    }

    const transactionsSize = totalSize - headerSize;
    const vsize = networkConfig?.hasSegWit ? Math.ceil(totalWeight / 4) : totalStrippedSize;

    return {
      size: totalSize,
      strippedSize: totalStrippedSize,
      weight: totalWeight,
      vsize,
      witnessSize: networkConfig?.hasSegWit ? totalWitnessSize : 0,
      headerSize,
      transactionsSize,
    };
  }

  /**
   * Calculate transaction size with network awareness
   */
  static calculateTransactionSize(
    tx: Transaction,
    networkConfig?: NetworkConfig
  ): {
    size: number;
    strippedSize: number;
    weight: number;
    vsize: number;
    witnessSize: number;
  } {
    // Calculate from transaction object
    let size = 4; // version
    let strippedSize = 4;
    let weight = 4 * 4;
    let witnessSize = 0;

    // Input count
    const vinCountSize = this.getVarintSize(tx.vin.length);
    size += vinCountSize;
    strippedSize += vinCountSize;
    weight += vinCountSize * 4;

    // Inputs
    let hasWitness = false;
    for (const vin of tx.vin) {
      let inputSize = 0;

      if (vin.coinbase) {
        inputSize = 32 + 4 + this.getVarintSize(vin.coinbase.length / 2) + vin.coinbase.length / 2 + 4;
      } else {
        inputSize =
          32 +
          4 +
          this.getVarintSize((vin.scriptSig?.hex?.length || 0) / 2) +
          (vin.scriptSig?.hex?.length || 0) / 2 +
          4;

        // Check for witness data only if network supports SegWit
        if (networkConfig?.hasSegWit && vin.txinwitness && vin.txinwitness.length > 0) {
          hasWitness = true;
          const inputWitnessSize = this.calculateWitnessSize(vin.txinwitness);
          witnessSize += inputWitnessSize;
          size += inputWitnessSize;
          weight += inputWitnessSize;
        }
      }

      size += inputSize;
      strippedSize += inputSize;
      weight += inputSize * 4;
    }

    // Output count
    const voutCountSize = this.getVarintSize(tx.vout.length);
    size += voutCountSize;
    strippedSize += voutCountSize;
    weight += voutCountSize * 4;

    // Outputs
    for (const vout of tx.vout) {
      const outputSize =
        8 + this.getVarintSize((vout.scriptPubKey?.hex?.length || 0) / 2) + (vout.scriptPubKey?.hex?.length || 0) / 2;
      size += outputSize;
      strippedSize += outputSize;
      weight += outputSize * 4;
    }

    // Witness flag and marker (only for SegWit networks with witness data)
    if (networkConfig?.hasSegWit && hasWitness) {
      size += 2; // marker + flag
      weight += 2;
    }

    // Locktime
    size += 4;
    strippedSize += 4;
    weight += 4 * 4;

    const vsize = networkConfig?.hasSegWit ? Math.ceil(weight / 4) : strippedSize;

    return {
      size,
      strippedSize,
      weight,
      vsize,
      witnessSize: networkConfig?.hasSegWit ? witnessSize : 0,
    };
  }

  /**
   * Calculate transaction size from hex with network awareness
   */
  static calculateTransactionSizeFromHex(
    hex: string,
    networkConfig?: NetworkConfig
  ): {
    size: number;
    strippedSize: number;
    weight: number;
    vsize: number;
    witnessSize: number;
  } {
    if (!hex) {
      return this.createEmptyTransactionResult();
    }

    try {
      const buffer = Buffer.from(hex, 'hex');
      const tx = bitcoin.Transaction.fromBuffer(buffer);

      const size = buffer.length;
      const strippedSize = this.calculateTransactionStrippedSize(tx);

      let weight: number;
      let witnessSize: number;
      let vsize: number;

      if (networkConfig?.hasSegWit) {
        weight = tx.weight();
        witnessSize = Math.max(0, weight - strippedSize * 4);
        vsize = tx.virtualSize();
      } else {
        // For non-SegWit networks
        weight = strippedSize * 4;
        witnessSize = 0;
        vsize = strippedSize;
      }

      return {
        size,
        strippedSize,
        weight,
        vsize,
        witnessSize,
      };
    } catch (error) {
      throw new Error(`Failed to calculate transaction size from hex: ${error}`);
    }
  }

  /**
   * Calculate transaction stripped size (without witness data)
   */
  private static calculateTransactionStrippedSize(tx: bitcoin.Transaction): number {
    let size = 4; // version

    // Input count
    size += this.getVarintSize(tx.ins.length);

    // Inputs (without witness)
    for (const input of tx.ins) {
      size += 32; // prev hash
      size += 4; // prev index
      size += this.getVarintSize(input.script.length);
      size += input.script.length;
      size += 4; // sequence
    }

    // Output count
    size += this.getVarintSize(tx.outs.length);

    // Outputs
    for (const output of tx.outs) {
      size += 8; // value
      size += this.getVarintSize(output.script.length);
      size += output.script.length;
    }

    size += 4; // locktime

    return size;
  }

  /**
   * Calculate witness data size from witness array
   */
  private static calculateWitnessSize(witness: string[]): number {
    let size = this.getVarintSize(witness.length);

    for (const item of witness) {
      const itemLength = item.length / 2;
      size += this.getVarintSize(itemLength);
      size += itemLength;
    }

    return size;
  }

  /**
   * Get varint size in bytes
   */
  private static getVarintSize(value: number): number {
    if (value < 0xfd) return 1;
    if (value <= 0xffff) return 3;
    if (value <= 0xffffffff) return 5;
    return 9;
  }

  /**
   * Calculate block size efficiency as percentage of max block size
   */
  static calculateBlockSizeEfficiency(blockSize: number, maxBlockSize: number): number {
    if (maxBlockSize <= 0) return 0;
    return Math.round((blockSize / maxBlockSize) * 100 * 100) / 100; // Round to 2 decimal places
  }

  /**
   * Calculate witness data ratio as percentage of total block size
   */
  static calculateWitnessDataRatio(witnessSize: number, totalSize: number): number {
    if (totalSize <= 0) return 0;
    return Math.round((witnessSize / totalSize) * 100 * 100) / 100; // Round to 2 decimal places
  }

  /**
   * Validate calculated sizes against known values
   */
  static validateSizes(
    calculated: any,
    known: any
  ): {
    isValid: boolean;
    differences: Record<string, number>;
  } {
    const differences: Record<string, number> = {};
    let isValid = true;

    // Check size
    if (known.size && Math.abs(calculated.size - known.size) > 0) {
      differences.size = calculated.size - known.size;
      isValid = false;
    }

    // Check stripped size
    if (known.strippedSize && Math.abs(calculated.strippedSize - known.strippedSize) > 0) {
      differences.strippedSize = calculated.strippedSize - known.strippedSize;
      isValid = false;
    }

    // Check weight
    if (known.weight && Math.abs(calculated.weight - known.weight) > 0) {
      differences.weight = calculated.weight - known.weight;
      isValid = false;
    }

    // Check vsize
    if (known.vsize && Math.abs(calculated.vsize - known.vsize) > 0) {
      differences.vsize = calculated.vsize - known.vsize;
      isValid = false;
    }

    return { isValid, differences };
  }

  /**
   * Create empty result for blocks
   */
  private static createEmptyResult(): {
    size: number;
    strippedSize: number;
    weight: number;
    vsize: number;
    witnessSize: number;
    headerSize: number;
    transactionsSize: number;
  } {
    return {
      size: 0,
      strippedSize: 0,
      weight: 0,
      vsize: 0,
      witnessSize: 0,
      headerSize: 80,
      transactionsSize: 0,
    };
  }

  /**
   * Create empty result for transactions
   */
  private static createEmptyTransactionResult(): {
    size: number;
    strippedSize: number;
    weight: number;
    vsize: number;
    witnessSize: number;
  } {
    return {
      size: 0,
      strippedSize: 0,
      weight: 0,
      vsize: 0,
      witnessSize: 0,
    };
  }
}
