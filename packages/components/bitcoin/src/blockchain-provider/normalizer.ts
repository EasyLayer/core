import type { NetworkConfig, UniversalBlock, UniversalBlockStats, UniversalTransaction } from './node-providers';
import type { Block, BlockStats, Transaction, Vin, Vout } from './components';

/**
 * Bitcoin Normalizer - converts Universal objects to enhanced component objects
 * Expects complete Universal objects with all size data already calculated
 * Only adds computed fields and enhanced metrics for better API usability
 */
export class BitcoinNormalizer {
  constructor(private readonly networkConfig: NetworkConfig) {}

  /**
   * Normalize UniversalBlock to enhanced Block component
   */
  public normalizeBlock(universalBlock: UniversalBlock): Block {
    // Ensure height is available - REQUIRED field
    if (universalBlock.height === undefined || universalBlock.height === null) {
      throw new Error(`Block height is required but missing for block ${universalBlock.hash}`);
    }

    // Calculate enhanced size metrics from existing data
    const sizeMetrics = this.calculateBlockSizeMetrics(universalBlock);

    // Normalize transactions if present
    const transactions =
      universalBlock.tx && Array.isArray(universalBlock.tx)
        ? (universalBlock.tx
            .map((tx) => (typeof tx === 'string' ? null : this.normalizeTransaction(tx)))
            .filter(Boolean) as Transaction[])
        : undefined;

    // Calculate efficiency metrics
    const efficiencyMetrics = this.calculateBlockEfficiencyMetrics(universalBlock, sizeMetrics);

    return {
      // Required fields
      height: universalBlock.height,
      hash: universalBlock.hash,

      // Enhanced size fields
      size: universalBlock.size || 0,
      strippedsize: universalBlock.strippedsize || 0,
      sizeWithoutWitnesses: universalBlock.strippedsize || 0, // Alias for clarity
      weight: universalBlock.weight || 0,
      vsize: sizeMetrics.vsize,
      witnessSize: sizeMetrics.witnessSize,
      headerSize: 80, // Bitcoin block header is always 80 bytes
      transactionsSize: sizeMetrics.transactionsSize,

      // Standard block fields
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

      // Additional fields
      fee: universalBlock.fee,
      subsidy: universalBlock.subsidy,
      miner: universalBlock.miner,
      pool: universalBlock.pool,

      // Efficiency metrics
      blockSizeEfficiency: efficiencyMetrics.blockSizeEfficiency,
      witnessDataRatio: efficiencyMetrics.witnessDataRatio,
    };
  }

  /**
   * Normalize multiple UniversalBlocks to enhanced Block components
   */
  public normalizeManyBlocks(universalBlocks: UniversalBlock[]): Block[] {
    return universalBlocks.map((block) => this.normalizeBlock(block));
  }

  /**
   * Normalize UniversalTransaction to enhanced Transaction component
   */
  public normalizeTransaction(universalTx: UniversalTransaction): Transaction {
    // Calculate enhanced size metrics from existing data
    const sizeMetrics = this.calculateTransactionSizeMetrics(universalTx);

    // Normalize inputs and outputs
    const vin = universalTx.vin.map((input) => this.normalizeVin(input));
    const vout = universalTx.vout.map((output) => this.normalizeVout(output));

    // Calculate fee rate if fee is available
    const feeRate = universalTx.fee && universalTx.vsize ? Math.round(universalTx.fee / universalTx.vsize) : undefined;

    return {
      txid: universalTx.txid,
      hash: universalTx.hash,
      version: universalTx.version,

      // Enhanced size fields
      size: universalTx.size,
      strippedsize: sizeMetrics.strippedsize,
      sizeWithoutWitnesses: sizeMetrics.strippedsize, // Alias for clarity
      vsize: universalTx.vsize,
      weight: universalTx.weight,
      witnessSize: sizeMetrics.witnessSize,

      locktime: universalTx.locktime,
      vin,
      vout,

      // Block context
      blockhash: universalTx.blockhash,
      time: universalTx.time,
      blocktime: universalTx.blocktime,

      // Fee information
      fee: universalTx.fee,
      feeRate,

      // SegWit and metadata
      wtxid: universalTx.wtxid,
      depends: universalTx.depends,
      spentby: universalTx.spentby,
      bip125_replaceable: universalTx.bip125_replaceable,
    };
  }

  /**
   * Normalize multiple UniversalTransactions to enhanced Transaction components
   */
  public normalizeManyTransactions(universalTxs: UniversalTransaction[]): Transaction[] {
    return universalTxs.map((tx) => this.normalizeTransaction(tx));
  }

  /**
   * Normalize UniversalBlockStats to enhanced BlockStats component
   */
  public normalizeBlockStats(universalStats: UniversalBlockStats): BlockStats {
    // Calculate witness statistics if available
    const witnessStats = this.calculateWitnessStatistics(universalStats);

    return {
      blockhash: universalStats.blockhash,
      height: universalStats.height,

      // Enhanced size stats
      total_size: universalStats.total_size,
      total_stripped_size: universalStats.total_stripped_size,
      total_witness_size: witnessStats.total_witness_size,
      total_weight: universalStats.total_weight,
      total_vsize: witnessStats.total_vsize,

      // Financial stats
      total_fee: universalStats.total_fee,
      fee_rate_percentiles: universalStats.fee_rate_percentiles,
      subsidy: universalStats.subsidy,
      total_out: universalStats.total_out,
      utxo_increase: universalStats.utxo_increase,
      utxo_size_inc: universalStats.utxo_size_inc,

      // Transaction counts
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
      witness_ratio: witnessStats.witness_ratio,
    };
  }

  /**
   * Normalize multiple UniversalBlockStats to enhanced BlockStats components
   */
  public normalizeManyBlockStats(universalStats: UniversalBlockStats[]): BlockStats[] {
    return universalStats.map((stats) => this.normalizeBlockStats(stats));
  }

  /**
   * Normalize UniversalVin to Vin component
   */
  private normalizeVin(universalVin: any): Vin {
    return {
      txid: universalVin.txid,
      vout: universalVin.vout,
      scriptSig: universalVin.scriptSig,
      sequence: universalVin.sequence,
      coinbase: universalVin.coinbase,
      txinwitness: universalVin.txinwitness,
    };
  }

  /**
   * Normalize UniversalVout to Vout component
   */
  private normalizeVout(universalVout: any): Vout {
    return {
      value: universalVout.value,
      n: universalVout.n,
      scriptPubKey: universalVout.scriptPubKey,
    };
  }

  /**
   * Calculate enhanced block size metrics from existing Universal block data
   * No external calculations - only uses data already present in Universal object
   */
  private calculateBlockSizeMetrics(block: UniversalBlock): {
    vsize: number;
    witnessSize?: number;
    transactionsSize: number;
  } {
    const blockSize = block.size || 0;
    const strippedSize = block.strippedsize || 0;
    const weight = block.weight || 0;

    // Calculate virtual size from weight (BIP 141)
    const vsize = weight > 0 ? Math.ceil(weight / 4) : strippedSize;

    // Calculate witness data size
    const witnessSize = this.networkConfig.hasSegWit && blockSize > strippedSize ? blockSize - strippedSize : undefined;

    // Calculate transactions size (total size minus 80-byte header)
    const transactionsSize = Math.max(0, blockSize - 80);

    return {
      vsize,
      witnessSize,
      transactionsSize,
    };
  }

  /**
   * Calculate block efficiency metrics from existing data
   */
  private calculateBlockEfficiencyMetrics(
    block: UniversalBlock,
    sizeMetrics: { witnessSize?: number }
  ): {
    blockSizeEfficiency?: number;
    witnessDataRatio?: number;
  } {
    const blockSize = block.size || 0;
    const maxBlockSize = this.networkConfig.maxBlockSize;

    // Calculate block size efficiency as percentage of maximum
    const blockSizeEfficiency = maxBlockSize > 0 ? (blockSize / maxBlockSize) * 100 : undefined;

    // Calculate witness data ratio
    const witnessDataRatio =
      sizeMetrics.witnessSize && blockSize > 0 ? (sizeMetrics.witnessSize / blockSize) * 100 : undefined;

    return {
      blockSizeEfficiency,
      witnessDataRatio,
    };
  }

  /**
   * Calculate enhanced transaction size metrics from existing Universal transaction data
   * Simple calculations based on data already present in Universal object
   */
  private calculateTransactionSizeMetrics(tx: UniversalTransaction): {
    strippedsize: number;
    witnessSize?: number;
  } {
    const txSize = tx.size || 0;
    const weight = tx.weight || 0;

    // For SegWit transactions, estimate stripped size from weight
    // Non-witness data has weight factor of 4, witness data has factor of 1
    // So: weight = (base_size * 4) + witness_size
    // Rough estimate: base_size ≈ weight / 4
    let strippedsize = txSize;
    let witnessSize: number | undefined;

    if (this.networkConfig.hasSegWit && weight > 0) {
      // Estimate stripped size from weight (this is an approximation)
      const estimatedBaseSize = Math.floor((weight + 3) / 4); // Round up division
      strippedsize = Math.min(estimatedBaseSize, txSize);

      // Calculate witness size
      if (txSize > strippedsize) {
        witnessSize = txSize - strippedsize;
      }
    }

    return {
      strippedsize,
      witnessSize,
    };
  }

  /**
   * Calculate witness statistics for block stats from existing data
   */
  private calculateWitnessStatistics(stats: UniversalBlockStats): {
    total_witness_size?: number;
    total_vsize?: number;
    witness_ratio?: number;
  } {
    const totalSize = stats.total_size || 0;
    const totalStrippedSize = stats.total_stripped_size;
    const totalWeight = stats.total_weight;
    const totalTxs = stats.txs || 0;
    const witnessTxs = stats.witness_txs;

    // Calculate total witness size
    const total_witness_size =
      totalStrippedSize !== undefined && totalSize > totalStrippedSize ? totalSize - totalStrippedSize : undefined;

    // Calculate total virtual size from weight
    const total_vsize = totalWeight ? Math.ceil(totalWeight / 4) : undefined;

    // Calculate witness transaction ratio
    const witness_ratio = witnessTxs !== undefined && totalTxs > 0 ? (witnessTxs / totalTxs) * 100 : undefined;

    return {
      total_witness_size,
      total_vsize,
      witness_ratio,
    };
  }
}
