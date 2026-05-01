import type {
  UniversalBlock,
  UniversalTransaction,
  UniversalTransactionReceipt,
  UniversalLog,
  NetworkConfig,
  EvmFieldPolicy,
} from './providers/interfaces';
import type { Block } from './components/block.interfaces';
import type { Transaction, TransactionReceipt, Log } from './components/transaction.interfaces';
import { BlockSizeCalculator } from './utils/block-size-calculator';
import {
  normalizeAddress,
  normalizeHex,
  optionalQuantityToDecimalString,
  quantityToDecimalString,
} from './value-normalization';

const DEFAULT_FIELD_POLICY: Required<
  Pick<
    EvmFieldPolicy,
    'allowLegacyReceiptRoot' | 'allowMissingTotalDifficulty' | 'allowMissingLogsBloom' | 'allowMissingNonce'
  >
> = {
  allowLegacyReceiptRoot: true,
  allowMissingTotalDifficulty: true,
  allowMissingLogsBloom: true,
  allowMissingNonce: true,
};

export class BlockchainNormalizer {
  private readonly networkConfig: NetworkConfig;
  private readonly fieldPolicy: EvmFieldPolicy;

  constructor(networkConfig: NetworkConfig) {
    this.networkConfig = networkConfig;
    this.fieldPolicy = { ...DEFAULT_FIELD_POLICY, ...(networkConfig.fieldPolicy ?? {}) };
  }

  normalizeBlock(rawBlock: UniversalBlock): Block {
    this.assertRequired(
      rawBlock,
      ['hash', 'parentHash', 'transactionsRoot', 'stateRoot', 'miner', 'extraData'],
      'Block'
    );

    if (rawBlock.blockNumber === undefined || rawBlock.blockNumber === null) {
      throw new Error('Block is missing required blockNumber field');
    }

    const txs = rawBlock.transactions ?? [];
    const fullTransactions = txs.filter((tx): tx is UniversalTransaction => typeof tx !== 'string');
    const transactionHashes = txs
      .map((tx) => (typeof tx === 'string' ? tx : tx.hash))
      .filter(Boolean)
      .map((tx) => normalizeHex(tx));

    const block: Block = {
      hash: normalizeHex(rawBlock.hash),
      parentHash: normalizeHex(rawBlock.parentHash),
      blockNumber: rawBlock.blockNumber,
      transactionsRoot: normalizeHex(rawBlock.transactionsRoot),
      stateRoot: normalizeHex(rawBlock.stateRoot),
      miner: normalizeAddress(rawBlock.miner),
      extraData: normalizeHex(rawBlock.extraData),
      size: 0,
      sizeWithoutReceipts: 0,
      gasLimit: rawBlock.gasLimit,
      gasUsed: rawBlock.gasUsed,
      timestamp: rawBlock.timestamp,
      uncles: rawBlock.uncles.map((u) => normalizeHex(u)),
      transactionHashes,
    };

    if (rawBlock.nonce !== undefined || !this.fieldPolicy.allowMissingNonce) {
      block.nonce = normalizeHex(rawBlock.nonce);
    }
    if (rawBlock.sha3Uncles !== undefined) block.sha3Uncles = normalizeHex(rawBlock.sha3Uncles);
    if (rawBlock.logsBloom !== undefined || !this.fieldPolicy.allowMissingLogsBloom) {
      block.logsBloom = normalizeHex(rawBlock.logsBloom);
    }
    if (rawBlock.receiptsRoot !== undefined) block.receiptsRoot = normalizeHex(rawBlock.receiptsRoot);
    if (rawBlock.difficulty !== undefined) block.difficulty = quantityToDecimalString(rawBlock.difficulty);
    if (rawBlock.totalDifficulty !== undefined) {
      block.totalDifficulty = quantityToDecimalString(rawBlock.totalDifficulty);
    } else if (!this.fieldPolicy.allowMissingTotalDifficulty) {
      throw new Error('Block is missing required totalDifficulty field');
    }

    if (this.networkConfig.hasEIP1559 && rawBlock.baseFeePerGas !== undefined) {
      block.baseFeePerGas = quantityToDecimalString(rawBlock.baseFeePerGas);
    }

    if (this.networkConfig.hasWithdrawals) {
      if (rawBlock.withdrawals) {
        block.withdrawals = rawBlock.withdrawals.map((w) => ({
          index: quantityToDecimalString(w.index),
          validatorIndex: quantityToDecimalString(w.validatorIndex),
          address: normalizeAddress(w.address),
          amount: quantityToDecimalString(w.amount),
        }));
      }
      if (rawBlock.withdrawalsRoot) block.withdrawalsRoot = normalizeHex(rawBlock.withdrawalsRoot);
    }

    if (this.networkConfig.hasBlobTransactions) {
      if (rawBlock.blobGasUsed !== undefined) block.blobGasUsed = quantityToDecimalString(rawBlock.blobGasUsed);
      if (rawBlock.excessBlobGas !== undefined) block.excessBlobGas = quantityToDecimalString(rawBlock.excessBlobGas);
      if (rawBlock.parentBeaconBlockRoot) block.parentBeaconBlockRoot = normalizeHex(rawBlock.parentBeaconBlockRoot);
    }

    if (fullTransactions.length) {
      block.transactions = fullTransactions.map((tx) => this.normalizeTransaction(tx));
    }

    if (rawBlock.receipts) {
      block.receipts = rawBlock.receipts.map((receipt) => this.normalizeTransactionReceipt(receipt));
    }

    this.calculateBlockSizes(block, rawBlock);
    return block;
  }

  private calculateBlockSizes(block: Block, rawBlock: UniversalBlock): void {
    if (rawBlock.size && rawBlock.size > 0) {
      block.sizeWithoutReceipts = rawBlock.size;
    } else {
      block.sizeWithoutReceipts = BlockSizeCalculator.calculateBlockSizeFromDecodedTransactions(block);
    }

    if (block.receipts && block.receipts.length > 0) {
      const receiptsSize = BlockSizeCalculator.calculateReceiptsSize(block.receipts);
      block.size = block.sizeWithoutReceipts + receiptsSize;
    } else {
      block.size = block.sizeWithoutReceipts;
    }
  }

  normalizeTransaction(rawTx: UniversalTransaction): Transaction {
    this.assertRequired(rawTx, ['hash', 'from', 'value', 'gas', 'input'], 'Transaction');

    const transaction: Transaction = {
      hash: normalizeHex(rawTx.hash),
      blockHash: rawTx.blockHash ? normalizeHex(rawTx.blockHash) : null,
      blockNumber: rawTx.blockNumber ?? null,
      transactionIndex: rawTx.transactionIndex ?? null,
      nonce: rawTx.nonce,
      from: normalizeAddress(rawTx.from),
      to: rawTx.to ? normalizeAddress(rawTx.to) : null,
      value: quantityToDecimalString(rawTx.value),
      gas: rawTx.gas,
      input: normalizeHex(rawTx.input),
      type: rawTx.type ? normalizeHex(rawTx.type) : '0x0',
      chainId: rawTx.chainId ?? this.networkConfig.chainId,
    };

    const gasPrice = optionalQuantityToDecimalString(rawTx.gasPrice);
    const maxFeePerGas = optionalQuantityToDecimalString(rawTx.maxFeePerGas);
    const maxPriorityFeePerGas = optionalQuantityToDecimalString(rawTx.maxPriorityFeePerGas);
    if (gasPrice) transaction.gasPrice = gasPrice;
    if (maxFeePerGas) transaction.maxFeePerGas = maxFeePerGas;
    if (maxPriorityFeePerGas) transaction.maxPriorityFeePerGas = maxPriorityFeePerGas;
    if (rawTx.v) transaction.v = normalizeHex(rawTx.v);
    if (rawTx.r) transaction.r = normalizeHex(rawTx.r);
    if (rawTx.s) transaction.s = normalizeHex(rawTx.s);

    if (rawTx.accessList) {
      transaction.accessList = rawTx.accessList.map((entry) => ({
        address: normalizeAddress(entry.address),
        storageKeys: entry.storageKeys.map((key) => normalizeHex(key)),
      }));
    }

    const maxFeePerBlobGas = optionalQuantityToDecimalString(rawTx.maxFeePerBlobGas);
    if (maxFeePerBlobGas) transaction.maxFeePerBlobGas = maxFeePerBlobGas;
    if (rawTx.blobVersionedHashes)
      transaction.blobVersionedHashes = rawTx.blobVersionedHashes.map((h) => normalizeHex(h));

    return transaction;
  }

  normalizeTransactionReceipt(rawReceipt: UniversalTransactionReceipt): TransactionReceipt {
    this.assertRequired(
      rawReceipt,
      ['transactionHash', 'blockHash', 'from', 'cumulativeGasUsed', 'gasUsed'],
      'TransactionReceipt'
    );

    if (rawReceipt.blockNumber === undefined || rawReceipt.blockNumber === null) {
      throw new Error('TransactionReceipt is missing required blockNumber field');
    }

    if (rawReceipt.status === undefined && !rawReceipt.root && !this.fieldPolicy.allowLegacyReceiptRoot) {
      throw new Error('TransactionReceipt is missing status field');
    }

    const receipt: TransactionReceipt = {
      transactionHash: normalizeHex(rawReceipt.transactionHash),
      transactionIndex: rawReceipt.transactionIndex,
      blockHash: normalizeHex(rawReceipt.blockHash),
      blockNumber: rawReceipt.blockNumber,
      from: normalizeAddress(rawReceipt.from),
      to: rawReceipt.to ? normalizeAddress(rawReceipt.to) : null,
      cumulativeGasUsed: rawReceipt.cumulativeGasUsed,
      gasUsed: rawReceipt.gasUsed,
      contractAddress: rawReceipt.contractAddress ? normalizeAddress(rawReceipt.contractAddress) : null,
      logs: rawReceipt.logs.map((log) => this.normalizeLog(log)),
      type: rawReceipt.type ? normalizeHex(rawReceipt.type) : '0x0',
    };

    if (rawReceipt.logsBloom !== undefined || !this.fieldPolicy.allowMissingLogsBloom) {
      receipt.logsBloom = normalizeHex(rawReceipt.logsBloom);
    }
    if (rawReceipt.status !== undefined) receipt.status = rawReceipt.status;
    if (rawReceipt.root) receipt.root = normalizeHex(rawReceipt.root);

    const effectiveGasPrice = optionalQuantityToDecimalString(rawReceipt.effectiveGasPrice);
    if (effectiveGasPrice) receipt.effectiveGasPrice = effectiveGasPrice;

    if (this.networkConfig.hasBlobTransactions) {
      if (rawReceipt.blobGasUsed !== undefined) receipt.blobGasUsed = quantityToDecimalString(rawReceipt.blobGasUsed);
      if (rawReceipt.blobGasPrice !== undefined)
        receipt.blobGasPrice = quantityToDecimalString(rawReceipt.blobGasPrice);
    }

    return receipt;
  }

  normalizeLog(rawLog: UniversalLog): Log {
    this.assertRequired(rawLog, ['address', 'topics', 'data'], 'Log');

    return {
      address: normalizeAddress(rawLog.address),
      topics: rawLog.topics.map((topic) => normalizeHex(topic)),
      data: normalizeHex(rawLog.data),
      blockNumber: rawLog.blockNumber ?? null,
      transactionHash: rawLog.transactionHash ? normalizeHex(rawLog.transactionHash) : null,
      transactionIndex: rawLog.transactionIndex ?? null,
      blockHash: rawLog.blockHash ? normalizeHex(rawLog.blockHash) : null,
      logIndex: rawLog.logIndex ?? null,
      removed: rawLog.removed ?? false,
    };
  }

  public getNetworkConfig(): NetworkConfig {
    return this.networkConfig;
  }

  private assertRequired(obj: Record<string, any>, fields: string[], modelName: string): void {
    for (const field of fields) {
      if (obj[field] === undefined || obj[field] === null || obj[field] === '') {
        throw new Error(`${modelName} is missing required ${field} field`);
      }
    }
  }
}
