import type {
  UniversalBlock,
  UniversalTransaction,
  UniversalTransactionReceipt,
  UniversalLog,
  NetworkConfig,
} from './node-providers';
import type { Block } from './components/block.interfaces';
import type { Transaction, TransactionReceipt, Log } from './components/transaction.interfaces';
import { BlockSizeCalculator } from './utils';

export class BlockchainNormalizer {
  private networkConfig: NetworkConfig;

  constructor(networkConfig: NetworkConfig) {
    this.networkConfig = networkConfig;
  }

  /**
   * Normalizes a raw block from any provider into the application Block interface
   * Now includes normalization of receipts if present
   * Automatically calculates block size with and without receipts
   */
  normalizeBlock(rawBlock: UniversalBlock): Block {
    // Ensure blockNumber is present - required for final Block interface
    if (rawBlock.blockNumber === undefined || rawBlock.blockNumber === null) {
      throw new Error('Block is missing required blockNumber field');
    }

    const block: Block = {
      hash: rawBlock.hash,
      parentHash: rawBlock.parentHash,
      blockNumber: rawBlock.blockNumber, // Now guaranteed to be present
      nonce: rawBlock.nonce,
      sha3Uncles: rawBlock.sha3Uncles,
      logsBloom: rawBlock.logsBloom,
      transactionsRoot: rawBlock.transactionsRoot,
      stateRoot: rawBlock.stateRoot,
      receiptsRoot: rawBlock.receiptsRoot,
      miner: rawBlock.miner,
      difficulty: rawBlock.difficulty,
      totalDifficulty: rawBlock.totalDifficulty,
      extraData: rawBlock.extraData,
      size: 0, // Will be calculated below
      sizeWithoutReceipts: 0, // Will be calculated below
      gasLimit: rawBlock.gasLimit,
      gasUsed: rawBlock.gasUsed,
      timestamp: rawBlock.timestamp,
      uncles: rawBlock.uncles,
    };

    // Add network-specific fields
    if (this.networkConfig.hasEIP1559 && rawBlock.baseFeePerGas) {
      block.baseFeePerGas = rawBlock.baseFeePerGas;
    }

    if (this.networkConfig.hasWithdrawals) {
      if (rawBlock.withdrawals) {
        block.withdrawals = rawBlock.withdrawals.map((w) => ({
          index: w.index,
          validatorIndex: w.validatorIndex,
          address: w.address,
          amount: w.amount,
        }));
      }
      if (rawBlock.withdrawalsRoot) {
        block.withdrawalsRoot = rawBlock.withdrawalsRoot;
      }
    }

    if (this.networkConfig.hasBlobTransactions) {
      if (rawBlock.blobGasUsed) block.blobGasUsed = rawBlock.blobGasUsed;
      if (rawBlock.excessBlobGas) block.excessBlobGas = rawBlock.excessBlobGas;
      if (rawBlock.parentBeaconBlockRoot) block.parentBeaconBlockRoot = rawBlock.parentBeaconBlockRoot;
    }

    // Normalize transactions if present
    if (rawBlock.transactions) {
      block.transactions = rawBlock.transactions.map((tx) => this.normalizeTransaction(tx));
    }

    // Normalize receipts if present
    if (rawBlock.receipts) {
      block.receipts = rawBlock.receipts.map((receipt) => this.normalizeTransactionReceipt(receipt));
    }

    // Calculate sizes
    this.calculateBlockSizes(block, rawBlock);

    return block;
  }

  /**
   * Calculates both size (with receipts) and sizeWithoutReceipts for a block
   */
  private calculateBlockSizes(block: Block, rawBlock: UniversalBlock): void {
    // First calculate size without receipts (original block + transactions)
    if (rawBlock.size && rawBlock.size > 0) {
      // If provider gives us the original block size, use it
      block.sizeWithoutReceipts = rawBlock.size;
    } else {
      // Calculate from block structure
      block.sizeWithoutReceipts = BlockSizeCalculator.calculateBlockSizeFromDecodedTransactions(block);
    }

    // Calculate total size including receipts
    if (block.receipts && block.receipts.length > 0) {
      const receiptsSize = BlockSizeCalculator.calculateReceiptsSize(block.receipts);
      block.size = block.sizeWithoutReceipts + receiptsSize;
    } else {
      // No receipts, so both sizes are the same
      block.size = block.sizeWithoutReceipts;
    }
  }

  /**
   * Normalizes a raw transaction from any provider into the application Transaction interface
   */
  normalizeTransaction(rawTx: UniversalTransaction): Transaction {
    const transaction: Transaction = {
      hash: rawTx.hash,
      blockHash: rawTx.blockHash || '',
      blockNumber: rawTx.blockNumber || 0,
      transactionIndex: rawTx.transactionIndex || 0,
      nonce: rawTx.nonce,
      from: rawTx.from,
      to: rawTx.to,
      value: rawTx.value,
      gas: rawTx.gas,
      input: rawTx.input,
      type: rawTx.type || '0x0',
      chainId: rawTx.chainId || this.networkConfig.chainId,
      v: rawTx.v || '',
      r: rawTx.r || '',
      s: rawTx.s || '',
    };

    // Always preserve all available gas fields
    if (rawTx.gasPrice) {
      transaction.gasPrice = rawTx.gasPrice;
    }
    if (rawTx.maxFeePerGas) {
      transaction.maxFeePerGas = rawTx.maxFeePerGas;
    }
    if (rawTx.maxPriorityFeePerGas) {
      transaction.maxPriorityFeePerGas = rawTx.maxPriorityFeePerGas;
    }

    // Optional fields
    if (rawTx.accessList) {
      transaction.accessList = rawTx.accessList.map((entry) => ({
        address: entry.address,
        storageKeys: entry.storageKeys,
      }));
    }

    if (rawTx.maxFeePerBlobGas) {
      transaction.maxFeePerBlobGas = rawTx.maxFeePerBlobGas;
    }
    if (rawTx.blobVersionedHashes) {
      transaction.blobVersionedHashes = rawTx.blobVersionedHashes;
    }

    return transaction;
  }

  /**
   * Normalizes a raw transaction receipt from any provider
   */
  normalizeTransactionReceipt(rawReceipt: UniversalTransactionReceipt): TransactionReceipt {
    // Ensure blockNumber is present - required for final TransactionReceipt interface
    if (rawReceipt.blockNumber === undefined || rawReceipt.blockNumber === null) {
      throw new Error('TransactionReceipt is missing required blockNumber field');
    }

    const receipt: TransactionReceipt = {
      transactionHash: rawReceipt.transactionHash,
      transactionIndex: rawReceipt.transactionIndex,
      blockHash: rawReceipt.blockHash,
      blockNumber: rawReceipt.blockNumber,
      from: rawReceipt.from,
      to: rawReceipt.to,
      cumulativeGasUsed: rawReceipt.cumulativeGasUsed,
      gasUsed: rawReceipt.gasUsed,
      contractAddress: rawReceipt.contractAddress,
      logs: rawReceipt.logs.map((log) => this.normalizeLog(log)),
      logsBloom: rawReceipt.logsBloom,
      status: rawReceipt.status,
      type: rawReceipt.type || '0x0',
      effectiveGasPrice: rawReceipt.effectiveGasPrice || 0,
    };

    // Add network-specific fields
    if (this.networkConfig.hasBlobTransactions) {
      if (rawReceipt.blobGasUsed) receipt.blobGasUsed = rawReceipt.blobGasUsed;
      if (rawReceipt.blobGasPrice) receipt.blobGasPrice = rawReceipt.blobGasPrice;
    }

    return receipt;
  }

  /**
   * Normalizes a raw log from any provider
   */
  normalizeLog(rawLog: UniversalLog): Log {
    return {
      address: rawLog.address,
      topics: rawLog.topics,
      data: rawLog.data,
      blockNumber: rawLog.blockNumber || 0,
      transactionHash: rawLog.transactionHash || '',
      transactionIndex: rawLog.transactionIndex || 0,
      blockHash: rawLog.blockHash || '',
      logIndex: rawLog.logIndex || 0,
      removed: rawLog.removed || false,
    };
  }

  /**
   * Gets the current network configuration
   */
  public getNetworkConfig(): NetworkConfig {
    return this.networkConfig;
  }

  /**
   * Get detailed size breakdown for a block
   */
  public getBlockSizeBreakdown(block: Block): {
    total: number;
    sizeWithoutReceipts: number;
    receiptsSize: number;
    header: number;
    transactions: number;
    receipts: {
      total: number;
      count: number;
      averageSize: number;
    };
  } {
    const headerSize = BlockSizeCalculator.estimateBlockHeaderSize(block);

    let transactionsSize = 0;
    if (block.transactions) {
      transactionsSize = block.transactions.reduce((sum, tx) => {
        if (typeof tx === 'string') {
          return sum + 32; // Just hash
        } else {
          return sum + BlockSizeCalculator.calculateTransactionSize(tx);
        }
      }, 0);
    }

    const receiptsSize = block.receipts ? BlockSizeCalculator.calculateReceiptsSize(block.receipts) : 0;
    const receiptsCount = block.receipts?.length || 0;

    return {
      total: block.size,
      sizeWithoutReceipts: block.sizeWithoutReceipts,
      receiptsSize,
      header: headerSize,
      transactions: transactionsSize,
      receipts: {
        total: receiptsSize,
        count: receiptsCount,
        averageSize: receiptsCount > 0 ? Math.round(receiptsSize / receiptsCount) : 0,
      },
    };
  }
}
