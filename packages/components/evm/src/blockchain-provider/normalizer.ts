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
   * Automatically calculates block size if not provided
   */
  normalizeBlock(rawBlock: UniversalBlock): Block {
    const block: Block = {
      hash: rawBlock.hash,
      parentHash: rawBlock.parentHash,
      blockNumber: this.extractBlockNumber(rawBlock),
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
      size: rawBlock.size || 0, // Will be calculated later if 0
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

    // Calculate block size if not provided or is 0
    if (!block.size || block.size <= 0) {
      block.size = BlockSizeCalculator.calculateBlockSizeFromDecodedTransactions(block);
    }

    return block;
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

    // Handle gas pricing based on transaction type and network capabilities
    if (transaction.type === '0x0' || transaction.type === '0x1' || !this.networkConfig.hasEIP1559) {
      // Legacy or EIP-2930 transactions, or network doesn't support EIP-1559
      transaction.gasPrice = rawTx.gasPrice;
    } else if (transaction.type === '0x2' && this.networkConfig.hasEIP1559) {
      // EIP-1559 transactions
      transaction.maxFeePerGas = rawTx.maxFeePerGas;
      transaction.maxPriorityFeePerGas = rawTx.maxPriorityFeePerGas;
    }

    // Add optional fields
    if (rawTx.accessList) {
      transaction.accessList = rawTx.accessList.map((entry) => ({
        address: entry.address,
        storageKeys: entry.storageKeys,
      }));
    }

    if (this.networkConfig.hasBlobTransactions && transaction.type === '0x3') {
      transaction.maxFeePerBlobGas = rawTx.maxFeePerBlobGas;
      transaction.blobVersionedHashes = rawTx.blobVersionedHashes;
    }

    return transaction;
  }

  /**
   * Normalizes a raw transaction receipt from any provider
   */
  normalizeTransactionReceipt(rawReceipt: UniversalTransactionReceipt): TransactionReceipt {
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
   * Extracts block number from different provider formats
   */
  private extractBlockNumber(block: UniversalBlock): number {
    return block.blockNumber ?? block.number ?? 0;
  }
}
