import type {
  UniversalBlock,
  UniversalTransaction,
  UniversalVin,
  UniversalVout,
  UniversalBlockStats,
  NetworkConfig,
} from './node-providers';
import type { Block, Transaction, Vin, Vout, BlockStats } from './components';
import { BlockSizeCalculator } from './utils/block-size-calculator';

export class BitcoinNormalizer {
  private networkConfig: NetworkConfig;

  constructor(networkConfig: NetworkConfig) {
    this.networkConfig = networkConfig;
  }

  /**
   * Normalizes a universal Bitcoin block from any provider into the application Block interface
   * Throws error if block doesn't have height (which is required)
   */
  normalizeBlock(universalBlock: UniversalBlock): Block {
    // Height is required for Block interface
    if (universalBlock.height === undefined) {
      throw new Error('Block height is required for normalization');
    }

    let transactions: Transaction[] | undefined;

    // Handle different transaction formats
    if (universalBlock.tx) {
      if (Array.isArray(universalBlock.tx) && universalBlock.tx.length > 0) {
        // Check if it's array of transaction objects or hashes
        if (typeof universalBlock.tx[0] === 'string') {
          // Array of transaction hashes - don't normalize, keep as undefined
          transactions = undefined;
        } else {
          // Array of transaction objects - normalize each
          transactions = (universalBlock.tx as UniversalTransaction[]).map((tx) => this.normalizeTransaction(tx));
        }
      }
    }

    // Calculate enhanced sizes if we have hex or can calculate from transactions
    let enhancedSizes: any = {};

    if (universalBlock.hex) {
      // Calculate from hex for most accurate results
      const calculatedSizes = BlockSizeCalculator.calculateSizeFromHex(universalBlock.hex, this.networkConfig);
      enhancedSizes = {
        size: calculatedSizes.size,
        strippedsize: calculatedSizes.strippedSize,
        sizeWithoutWitnesses: calculatedSizes.strippedSize,
        weight: calculatedSizes.weight,
        vsize: calculatedSizes.vsize,
        witnessSize: calculatedSizes.witnessSize,
        headerSize: calculatedSizes.headerSize,
        transactionsSize: calculatedSizes.transactionsSize,
      };
    } else if (transactions && transactions.length > 0) {
      // Calculate from transaction data if available
      const blockWithTx = {
        ...universalBlock,
        tx: transactions,
      } as Block;
      const calculatedSizes = BlockSizeCalculator.calculateSizeFromBlock(blockWithTx, this.networkConfig);
      enhancedSizes = {
        size: calculatedSizes.size,
        strippedsize: calculatedSizes.strippedSize,
        sizeWithoutWitnesses: calculatedSizes.strippedSize,
        weight: calculatedSizes.weight,
        vsize: calculatedSizes.vsize,
        witnessSize: calculatedSizes.witnessSize,
        headerSize: calculatedSizes.headerSize,
        transactionsSize: calculatedSizes.transactionsSize,
      };
    }

    // Calculate efficiency metrics
    const blockSizeEfficiency = this.calculateBlockSizeEfficiency(
      enhancedSizes.size || universalBlock.size,
      this.networkConfig.maxBlockSize
    );

    const witnessDataRatio = this.calculateWitnessDataRatio(
      enhancedSizes.witnessSize || 0,
      enhancedSizes.size || universalBlock.size
    );

    // Fallback to existing values if calculations failed
    const witnessSize =
      enhancedSizes.witnessSize ??
      (this.networkConfig.hasSegWit ? Math.max(0, universalBlock.size - universalBlock.strippedsize) : 0);
    const headerSize = enhancedSizes.headerSize ?? 80;
    const transactionsSize = enhancedSizes.transactionsSize ?? universalBlock.size - headerSize;

    const block: Block = {
      height: universalBlock.height, // REQUIRED - always must be known
      hash: universalBlock.hash,

      // Enhanced size fields - use calculated or fallback to provider values
      size: enhancedSizes.size ?? universalBlock.size,
      strippedsize: enhancedSizes.strippedsize ?? universalBlock.strippedsize,
      sizeWithoutWitnesses: enhancedSizes.sizeWithoutWitnesses ?? universalBlock.strippedsize,
      weight: enhancedSizes.weight ?? universalBlock.weight,
      vsize: enhancedSizes.vsize ?? Math.ceil((universalBlock.weight || 0) / 4),
      witnessSize,
      headerSize,
      transactionsSize,

      version: universalBlock.version,
      versionHex: universalBlock.versionHex,
      merkleroot: universalBlock.merkleroot,
      time: universalBlock.time,
      mediantime: universalBlock.mediantime,
      nonce: universalBlock.nonce,
      bits: universalBlock.bits,
      difficulty: universalBlock.difficulty,
      chainwork: universalBlock.chainwork,
      previousblockhash: universalBlock.previousblockhash,
      nextblockhash: universalBlock.nextblockhash,
      tx: transactions,
      nTx: universalBlock.nTx,

      // Efficiency metrics
      blockSizeEfficiency,
      witnessDataRatio,
    };

    // Add network-specific fields
    if (universalBlock.fee !== undefined) {
      block.fee = universalBlock.fee;
    }

    if (universalBlock.subsidy !== undefined) {
      block.subsidy = universalBlock.subsidy;
    }

    if (universalBlock.miner !== undefined) {
      block.miner = universalBlock.miner;
    }

    if (universalBlock.pool !== undefined) {
      block.pool = universalBlock.pool;
    }

    return block;
  }

  /**
   * Normalizes a universal Bitcoin transaction from any provider into the application Transaction interface
   */
  normalizeTransaction(universalTx: UniversalTransaction): Transaction {
    // Calculate enhanced sizes
    let enhancedSizes: any = {};

    if (universalTx.hex) {
      // Calculate from hex for most accurate results
      const calculatedSizes = BlockSizeCalculator.calculateTransactionSizeFromHex(universalTx.hex, this.networkConfig);
      enhancedSizes = {
        size: calculatedSizes.size,
        strippedsize: calculatedSizes.strippedSize,
        sizeWithoutWitnesses: calculatedSizes.strippedSize,
        vsize: calculatedSizes.vsize,
        weight: calculatedSizes.weight,
        witnessSize: calculatedSizes.witnessSize,
      };
    } else {
      // Calculate from transaction object
      const txForCalculation = {
        ...universalTx,
        vin: universalTx.vin.map((vin) => this.normalizeVin(vin)),
        vout: universalTx.vout.map((vout) => this.normalizeVout(vout)),
      } as Transaction;

      const calculatedSizes = BlockSizeCalculator.calculateTransactionSize(txForCalculation, this.networkConfig);
      enhancedSizes = {
        size: calculatedSizes.size,
        strippedsize: calculatedSizes.strippedSize,
        sizeWithoutWitnesses: calculatedSizes.strippedSize,
        vsize: calculatedSizes.vsize,
        weight: calculatedSizes.weight,
        witnessSize: calculatedSizes.witnessSize,
      };
    }

    // Fallback to existing values if calculations failed
    const witnessSize =
      enhancedSizes.witnessSize ??
      (this.networkConfig.hasSegWit ? Math.max(0, (universalTx.weight || 0) - universalTx.size * 4) : 0);

    // Calculate fee rate
    let feeRate: number | undefined;
    if (universalTx.fee !== undefined && (enhancedSizes.vsize || universalTx.vsize) > 0) {
      feeRate = universalTx.fee / (enhancedSizes.vsize || universalTx.vsize);
    }

    const transaction: Transaction = {
      txid: universalTx.txid,
      hash: universalTx.hash,
      version: universalTx.version,

      // Enhanced size fields - use calculated or fallback to provider values
      size: enhancedSizes.size ?? universalTx.size,
      strippedsize: enhancedSizes.strippedsize ?? universalTx.size, // Fallback if not available
      sizeWithoutWitnesses: enhancedSizes.sizeWithoutWitnesses ?? universalTx.size,
      vsize: enhancedSizes.vsize ?? universalTx.vsize,
      weight: enhancedSizes.weight ?? universalTx.weight,
      witnessSize,

      locktime: universalTx.locktime,
      vin: universalTx.vin.map((vin) => this.normalizeVin(vin)),
      vout: universalTx.vout.map((vout) => this.normalizeVout(vout)),
      blockhash: universalTx.blockhash,
      time: universalTx.time,
      blocktime: universalTx.blocktime,
    };

    // Add network-specific fields
    if (universalTx.fee !== undefined) {
      transaction.fee = universalTx.fee;
      transaction.feeRate = feeRate;
    }

    // SegWit specific fields - only if network supports SegWit
    if (this.networkConfig.hasSegWit && universalTx.wtxid) {
      transaction.wtxid = universalTx.wtxid;
    }

    // RBF specific fields - only if network supports RBF
    if (this.networkConfig.hasRBF && universalTx.bip125_replaceable !== undefined) {
      transaction.bip125_replaceable = universalTx.bip125_replaceable;
    }

    // Mempool specific fields
    if (universalTx.depends !== undefined) {
      transaction.depends = universalTx.depends;
    }

    if (universalTx.spentby !== undefined) {
      transaction.spentby = universalTx.spentby;
    }

    return transaction;
  }

  /**
   * Normalizes universal Bitcoin Vin to application Vin interface
   */
  private normalizeVin(universalVin: UniversalVin): Vin {
    const vin: Vin = {
      txid: universalVin.txid,
      vout: universalVin.vout,
      scriptSig: universalVin.scriptSig
        ? {
            asm: universalVin.scriptSig.asm,
            hex: universalVin.scriptSig.hex,
          }
        : undefined,
      sequence: universalVin.sequence,
      coinbase: universalVin.coinbase,
    };

    // SegWit witness data - only if network supports SegWit
    if (this.networkConfig.hasSegWit && universalVin.txinwitness) {
      vin.txinwitness = universalVin.txinwitness;
    }

    return vin;
  }

  /**
   * Normalizes universal Bitcoin Vout to application Vout interface
   */
  private normalizeVout(universalVout: UniversalVout): Vout {
    let addresses: string[] | undefined;

    // Handle both single address and array of addresses
    if (universalVout.scriptPubKey?.addresses) {
      addresses = universalVout.scriptPubKey.addresses;
    } else if (universalVout.scriptPubKey?.address) {
      addresses = [universalVout.scriptPubKey.address];
    }

    return {
      value: universalVout.value,
      n: universalVout.n,
      scriptPubKey: universalVout.scriptPubKey
        ? {
            asm: universalVout.scriptPubKey.asm,
            hex: universalVout.scriptPubKey.hex,
            reqSigs: universalVout.scriptPubKey.reqSigs,
            type: universalVout.scriptPubKey.type,
            addresses: addresses,
          }
        : undefined,
    };
  }

  /**
   * Normalizes universal Bitcoin block stats with enhanced fields
   */
  normalizeBlockStats(universalStats: UniversalBlockStats): BlockStats {
    // Calculate enhanced witness statistics if possible
    const totalWitnessSize =
      universalStats.total_size && universalStats.total_stripped_size
        ? universalStats.total_size - universalStats.total_stripped_size
        : undefined;

    const witnessRatio =
      universalStats.witness_txs && universalStats.txs
        ? (universalStats.witness_txs / universalStats.txs) * 100
        : undefined;

    return {
      blockhash: universalStats.blockhash,
      height: universalStats.height,

      // Enhanced size fields
      total_size: universalStats.total_size,
      total_stripped_size: universalStats.total_stripped_size,
      total_witness_size: totalWitnessSize,
      total_weight: universalStats.total_weight,
      total_vsize: universalStats.total_weight ? Math.ceil(universalStats.total_weight / 4) : undefined,

      total_fee: universalStats.total_fee,
      fee_rate_percentiles: universalStats.fee_rate_percentiles,
      subsidy: universalStats.subsidy,
      total_out: universalStats.total_out,
      utxo_increase: universalStats.utxo_increase,
      utxo_size_inc: universalStats.utxo_size_inc,
      ins: universalStats.ins,
      outs: universalStats.outs,
      txs: universalStats.txs,

      // Fee statistics
      minfee: universalStats.minfee,
      maxfee: universalStats.maxfee,
      medianfee: universalStats.medianfee,
      avgfee: universalStats.avgfee,
      minfeerate: universalStats.minfeerate,
      maxfeerate: universalStats.maxfeerate,
      medianfeerate: universalStats.medianfeerate,
      avgfeerate: universalStats.avgfeerate,

      // Transaction size statistics
      mintxsize: universalStats.mintxsize,
      maxtxsize: universalStats.maxtxsize,
      mediantxsize: universalStats.mediantxsize,
      avgtxsize: universalStats.avgtxsize,

      // Witness statistics
      witness_txs: universalStats.witness_txs,
      witness_ratio: witnessRatio,
    };
  }

  /**
   * Get accurate block sizes from Block object
   */
  getBlockSizes(block: Block): {
    size: number;
    strippedSize: number;
    sizeWithoutWitnesses: number;
    weight: number;
    vsize: number;
    witnessSize: number;
    headerSize: number;
    transactionsSize: number;
  } {
    // Block already has enhanced fields
    return {
      size: block.size,
      strippedSize: block.strippedsize,
      sizeWithoutWitnesses: block.sizeWithoutWitnesses,
      weight: block.weight,
      vsize: block.vsize || Math.ceil(block.weight / 4),
      witnessSize: block.witnessSize || 0,
      headerSize: block.headerSize || 80,
      transactionsSize: block.transactionsSize || block.size - 80,
    };
  }

  /**
   * Get accurate transaction sizes from Transaction object
   */
  getTransactionSizes(tx: Transaction): {
    size: number;
    strippedSize: number;
    sizeWithoutWitnesses: number;
    weight: number;
    vsize: number;
    witnessSize: number;
    feeRate?: number;
  } {
    // Transaction already has enhanced fields
    return {
      size: tx.size,
      strippedSize: tx.strippedsize,
      sizeWithoutWitnesses: tx.sizeWithoutWitnesses,
      weight: tx.weight,
      vsize: tx.vsize,
      witnessSize: tx.witnessSize || 0,
      feeRate: tx.feeRate,
    };
  }

  /**
   * Calculate block size efficiency as percentage of max block size
   */
  private calculateBlockSizeEfficiency(blockSize: number, maxBlockSize: number): number {
    if (maxBlockSize <= 0) return 0;
    return Math.round((blockSize / maxBlockSize) * 100 * 100) / 100; // Round to 2 decimal places
  }

  /**
   * Calculate witness data ratio as percentage of total block size
   */
  private calculateWitnessDataRatio(witnessSize: number, totalSize: number): number {
    if (totalSize <= 0 || !this.networkConfig.hasSegWit) return 0;
    return Math.round((witnessSize / totalSize) * 100 * 100) / 100; // Round to 2 decimal places
  }

  /**
   * Validates if a block hash format is correct
   */
  isValidBlockHash(hash: string): boolean {
    return /^[a-fA-F0-9]{64}$/.test(hash);
  }

  /**
   * Validates if a transaction hash format is correct
   */
  isValidTransactionHash(hash: string): boolean {
    return /^[a-fA-F0-9]{64}$/.test(hash);
  }

  /**
   * Validates if block height is within reasonable bounds
   */
  isValidBlockHeight(height: number): boolean {
    return Number.isInteger(height) && height >= 0 && height <= 10000000;
  }

  /**
   * Normalizes many blocks - efficiently processing in a single loop
   */
  normalizeManyBlocks(universalBlocks: UniversalBlock[]): Block[] {
    const results: Block[] = [];

    for (const block of universalBlocks) {
      try {
        results.push(this.normalizeBlock(block));
      } catch (error) {
        // Skip blocks without height
      }
    }

    return results;
  }

  /**
   * Normalizes many transactions - efficiently processing in a single loop
   */
  normalizeManyTransactions(universalTransactions: UniversalTransaction[]): Transaction[] {
    const results: Transaction[] = [];

    for (const tx of universalTransactions) {
      results.push(this.normalizeTransaction(tx));
    }

    return results;
  }

  /**
   * Normalizes many block stats - efficiently processing in a single loop
   */
  normalizeManyBlockStats(universalStats: UniversalBlockStats[]): BlockStats[] {
    const results: BlockStats[] = [];

    for (const stats of universalStats) {
      results.push(this.normalizeBlockStats(stats));
    }

    return results;
  }
}
