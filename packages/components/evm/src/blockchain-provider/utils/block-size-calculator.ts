import type { Block } from '../components/block.interfaces';
import type { Transaction, TransactionReceipt } from '../components/transaction.interfaces';

/**
 * Utility class for calculating block and transaction sizes
 * Supports both hex-based and RLP-based calculations
 * Automatically assigns size to blocks if not present
 */
export class BlockSizeCalculator {
  /**
   * Calculate block size using the most accurate method available
   * If size is not present in block, it will be calculated and assigned
   * @param block - Block to calculate size for (will be mutated to include size)
   * @returns Size in bytes
   */
  static calculateBlockSize(block: Block): number {
    // Use provided size if available and reliable
    if (block.size != null && Number(block.size) > 0) {
      return Number(block.size);
    }

    // Calculate size from decoded transaction data and assign to block
    const calculatedSize = this.calculateBlockSizeFromDecodedTransactions(block);
    block.size = calculatedSize;

    return calculatedSize;
  }

  /**
   * Calculate block size using decoded transaction data (standard approach)
   * @param block - Block to calculate size for
   * @returns Size in bytes
   */
  static calculateBlockSizeFromDecodedTransactions(block: Block): number {
    let totalSize = 0;

    // Add block header size
    totalSize += this.estimateBlockHeaderSize(block);

    // Add transaction sizes
    if (Array.isArray(block.transactions)) {
      for (const transaction of block.transactions) {
        if (typeof transaction === 'string') {
          // Just a hash, minimal size
          totalSize += 32; // 32 bytes for transaction hash
        } else {
          // Decoded transaction - estimate size from fields
          totalSize += this.estimateTransactionSizeFromFields(transaction);
        }
      }
    }

    return totalSize;
  }

  /**
   * Calculate individual transaction size
   * @param transaction - Transaction to calculate size for
   * @returns Size in bytes
   */
  static calculateTransactionSize(transaction: Transaction): number {
    // Since hex data is not available from providers, always estimate from fields
    return this.estimateTransactionSizeFromFields(transaction);
  }

  /**
   * Efficiently calculates the total size of receipts in bytes
   * Uses approximation based on receipt structure to avoid expensive JSON.stringify
   * @param receipts - Array of transaction receipts
   * @returns Total size in bytes
   */
  static calculateReceiptsSize(receipts: TransactionReceipt[]): number {
    if (!receipts || receipts.length === 0) return 0;

    let totalSize = 0;

    receipts.forEach((receipt) => {
      // Base receipt size (fixed fields) ~200 bytes
      let receiptSize = 200;

      // Add size for logs
      receipt.logs.forEach((log) => {
        // Base log size ~150 bytes
        receiptSize += 150;

        // Add topic sizes (32 bytes each)
        receiptSize += log.topics.length * 32;

        // Add data size (hex string, so /2 for actual bytes)
        receiptSize += log.data.length / 2;
      });

      // Add variable string field sizes
      receiptSize += receipt.transactionHash.length;
      receiptSize += receipt.blockHash.length;
      receiptSize += receipt.from.length;
      receiptSize += receipt.to?.length || 0;
      receiptSize += receipt.contractAddress?.length || 0;
      receiptSize += receipt.logsBloom.length / 2; // hex string

      totalSize += receiptSize;
    });

    return totalSize;
  }

  /**
   * Alternative precise method for calculating receipts size (slower but accurate)
   * Use this for debugging or when you need exact measurements
   * @param receipts - Array of transaction receipts
   * @returns Precise size in bytes
   */
  static calculateReceiptsSizePrecise(receipts: TransactionReceipt[]): number {
    if (!receipts || receipts.length === 0) return 0;

    try {
      return JSON.stringify(receipts).length;
    } catch (error) {
      // Fallback to approximation if JSON.stringify fails
      return this.calculateReceiptsSize(receipts);
    }
  }

  /**
   * Get transaction size from hex data (most accurate)
   * @param hex - Hex string of transaction data
   * @returns Size in bytes
   * @deprecated Providers don't include hex data, use estimateTransactionSizeFromFields instead
   */
  static getTransactionSizeFromHex(hex: string): number {
    // Remove 0x prefix and calculate byte length
    const hexData = hex.replace(/^0x/, '');
    return hexData.length / 2; // Each byte = 2 hex characters
  }

  /**
   * Estimate transaction size from its fields when hex is not available
   * @param transaction - Transaction object
   * @returns Estimated size in bytes
   */
  static estimateTransactionSizeFromFields(transaction: Transaction): number {
    let size = 0;

    // Basic transaction fields
    size += 32; // hash
    size += 8; // nonce (usually small, but can be up to 32 bytes)
    size += 20; // from address
    size += transaction.to ? 20 : 0; // to address (null for contract creation)
    size += 32; // value
    size += 8; // gas limit
    size += 1; // transaction type

    // Signature fields
    size += 1; // v (1 byte)
    size += 32; // r (32 bytes)
    size += 32; // s (32 bytes)

    // Gas pricing
    if (transaction.gasPrice) {
      size += 32; // gasPrice
    }
    if (transaction.maxFeePerGas) {
      size += 32; // maxFeePerGas
    }
    if (transaction.maxPriorityFeePerGas) {
      size += 32; // maxPriorityFeePerGas
    }

    // Input data (variable size)
    if (transaction.input && transaction.input !== '0x') {
      size += (transaction.input.length - 2) / 2; // Convert hex to bytes
    }

    // EIP-2930 access list
    if (transaction.accessList && transaction.accessList.length > 0) {
      for (const entry of transaction.accessList) {
        size += 20; // address
        size += entry.storageKeys.length * 32; // storage keys
      }
    }

    // EIP-4844 blob fields
    if (transaction.maxFeePerBlobGas) {
      size += 32; // maxFeePerBlobGas
    }
    if (transaction.blobVersionedHashes) {
      size += transaction.blobVersionedHashes.length * 32; // blob hashes
    }

    // Add RLP encoding overhead (approximately 5%)
    size = Math.ceil(size * 1.05);

    // Minimum transaction size (simple legacy transaction)
    return Math.max(size, 108);
  }

  /**
   * Estimate block header size
   * @param block - Block object
   * @returns Estimated header size in bytes
   */
  static estimateBlockHeaderSize(block: Block): number {
    let headerSize = 0;

    // Standard block header fields
    headerSize += 32; // parentHash
    headerSize += 32; // sha3Uncles
    headerSize += 20; // miner
    headerSize += 32; // stateRoot
    headerSize += 32; // transactionsRoot
    headerSize += 32; // receiptsRoot
    headerSize += 256; // logsBloom
    headerSize += 32; // difficulty
    headerSize += 8; // blockNumber
    headerSize += 8; // gasLimit
    headerSize += 8; // gasUsed
    headerSize += 8; // timestamp
    headerSize += 8; // nonce
    headerSize += 32; // mixHash (usually present but not in our interface)

    // Variable size fields
    if (block.extraData) {
      headerSize += (block.extraData.length - 2) / 2; // extraData
    }

    // EIP-1559 baseFeePerGas
    if (block.baseFeePerGas !== undefined) {
      headerSize += 32;
    }

    // Shanghai fork withdrawals
    if (block.withdrawals && block.withdrawals.length > 0) {
      headerSize += 32; // withdrawalsRoot
      // Withdrawals are typically in the block body, not header
      for (const withdrawal of block.withdrawals) {
        headerSize += 8 + 8 + 20 + 32; // index + validatorIndex + address + amount
      }
    }

    // Cancun fork blob fields
    if (block.blobGasUsed !== undefined) {
      headerSize += 8; // blobGasUsed
    }
    if (block.excessBlobGas !== undefined) {
      headerSize += 8; // excessBlobGas
    }
    if (block.parentBeaconBlockRoot !== undefined) {
      headerSize += 32; // parentBeaconBlockRoot
    }

    // Add RLP encoding overhead (approximately 10% for header)
    return Math.ceil(headerSize * 1.1);
  }

  /**
   * Get block size breakdown for analysis
   * @param block - Block to analyze
   * @returns Detailed size breakdown
   */
  static getBlockSizeBreakdown(block: Block) {
    const headerSize = this.estimateBlockHeaderSize(block);
    let transactionsTotalSize = 0;

    const transactionSizes: Array<{
      hash: string;
      size: number;
      method: 'estimated' | 'hash-only';
    }> = [];

    if (Array.isArray(block.transactions)) {
      for (const transaction of block.transactions) {
        if (typeof transaction === 'string') {
          transactionSizes.push({
            hash: transaction,
            size: 32,
            method: 'hash-only',
          });
          transactionsTotalSize += 32;
        } else {
          const size = this.calculateTransactionSize(transaction);

          transactionSizes.push({
            hash: transaction.hash,
            size,
            method: 'estimated',
          });

          transactionsTotalSize += size;
        }
      }
    }

    return {
      total: headerSize + transactionsTotalSize,
      header: headerSize,
      transactions: {
        total: transactionsTotalSize,
        count: block.transactions?.length || 0,
        estimated:
          (block.transactions?.length || 0) - (block.transactions?.filter((tx) => typeof tx === 'string').length || 0),
        hashOnly: block.transactions?.filter((tx) => typeof tx === 'string').length || 0,
        details: transactionSizes,
      },
    };
  }

  /**
   * Check if block size calculation is accurate
   * @param block - Block to check
   * @returns Accuracy information
   */
  static getCalculationAccuracy(block: Block): {
    isAccurate: boolean;
    hasProvidedSize: boolean;
    totalTransactions: number;
    method: 'provided' | 'estimated';
  } {
    const hasProvidedSize = block.size != null && Number(block.size) > 0;
    const totalTransactions = Array.isArray(block.transactions) ? block.transactions.length : 0;

    return {
      isAccurate: hasProvidedSize, // Only provided size is truly accurate
      hasProvidedSize,
      totalTransactions,
      method: hasProvidedSize ? 'provided' : 'estimated',
    };
  }

  /**
   * Ensures a block has a size field, calculating it if necessary
   * @param block - Block to ensure has size
   * @returns The same block with guaranteed size field
   */
  static ensureBlockSize(block: Block): Block {
    if (block.size == null || Number(block.size) <= 0) {
      block.size = this.calculateBlockSizeFromDecodedTransactions(block);
    }
    return block;
  }
}
