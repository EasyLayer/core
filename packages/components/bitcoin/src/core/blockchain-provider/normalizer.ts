import type { NetworkConfig } from './transports';
import type {
  UniversalBlock,
  UniversalBlockStats,
  UniversalTransaction,
  UniversalMempoolInfo,
  UniversalMempoolTxMetadata,
} from './providers';
import type { Block, BlockStats, Transaction, Vin, Vout, MempoolTxMetadata, MempoolInfo } from './components';

/**
 * Bitcoin Normalizer - converts Universal objects to domain components.
 *
 * Rules:
 * - Do NOT fabricate defaults anywhere.
 * - Throw when a field is REQUIRED by the domain model and missing/invalid.
 * - Accept optional fields from Universal and pass through if present.
 */
export class BitcoinNormalizer {
  constructor(private readonly network: NetworkConfig) {}

  // =======================
  // Internal helpers
  // =======================

  /** Require a finite number; throw if absent/NaN. */
  private mustNumber(value: any, field: string): number {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      throw new Error(`Required numeric field "${field}" is missing or invalid`);
    }
    return n;
  }

  /** Optional numeric: returns number or undefined (no defaults). */
  private optNumber(value: any): number | undefined {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
    // No defaults here; absence stays absence.
  }

  /** VarInt size in bytes for a value (used for transactions count). */
  private varintSize(value: number): number {
    if (value < 0xfd) return 1;
    if (value <= 0xffff) return 3;
    if (value <= 0xffffffff) return 5;
    return 9;
  }

  // =======================
  // Blocks
  // =======================

  /**
   * REQUIRED by domain Block:
   * - height, hash, time
   * - size, strippedsize, weight, vsize
   * - headerSize (fixed 80), transactionsSize (must be computable)
   * - version, versionHex, merkleroot, mediantime, nonce, bits, difficulty, chainwork
   *
   * Notes:
   * - transactionsSize is computed from either tx objects or size/nTx:
   *     tx objects present → sum(tx.vsize)  (keeps behavior you had before)
   *     else if size & nTx present → size - 80 - varint(nTx)
   *     else → throw (cannot satisfy required domain field)
   * - sizeWithoutWitnesses is an alias for strippedsize.
   * - witnessSize = size - strippedsize when SegWit and both available.
   * - blockSizeEfficiency = size / maxBlockSize (0..1), witnessDataRatio = witnessSize / size.
   */
  public normalizeBlock(universalBlock: UniversalBlock): Block {
    if (!universalBlock || typeof universalBlock !== 'object') {
      throw new Error('Block object is required');
    }

    const hash = universalBlock.hash;
    if (!hash) throw new Error('Block hash is required');

    const height = this.mustNumber(universalBlock.height, 'block.height');
    const time = this.mustNumber(universalBlock.time, 'block.time');

    const size = this.mustNumber(universalBlock.size, 'block.size');
    const strippedsize = this.mustNumber(universalBlock.strippedsize, 'block.strippedsize');
    const weight = this.mustNumber(universalBlock.weight, 'block.weight');
    const vsize = this.mustNumber(universalBlock.vsize, 'block.vsize');

    const version = this.mustNumber(universalBlock.version, 'block.version');
    const versionHex = (universalBlock.versionHex ?? '').toString();
    if (!versionHex) throw new Error('block.versionHex is required');

    const merkleroot = (universalBlock.merkleroot ?? '').toString();
    if (!merkleroot) throw new Error('block.merkleroot is required');

    const nonce = this.mustNumber(universalBlock.nonce, 'block.nonce');

    const bits = (universalBlock.bits ?? '').toString();
    if (!bits) throw new Error('block.bits is required');

    const difficulty = (universalBlock.difficulty ?? '').toString();
    if (!difficulty) throw new Error('block.difficulty is required');

    // Compute transactionsSize
    let transactionsSize: number | undefined;
    if (Array.isArray(universalBlock.tx) && universalBlock.tx.length > 0 && typeof universalBlock.tx[0] !== 'string') {
      // sum of tx vsize, as in your previous implementation
      transactionsSize = (universalBlock.tx as UniversalTransaction[]).reduce((acc, t) => {
        const vs = this.mustTxVsize(t);
        return acc + vs;
      }, 0);
    } else if (Number.isFinite(size) && Number.isFinite(universalBlock.nTx)) {
      const nTx = this.mustNumber(universalBlock.nTx, 'block.nTx');
      transactionsSize = size - 80 - this.varintSize(nTx);
      if (!Number.isFinite(transactionsSize) || transactionsSize < 0) {
        throw new Error('Failed to compute block.transactionsSize from size and nTx');
      }
    } else {
      throw new Error('block.transactionsSize cannot be computed (neither tx objects nor nTx/size are present)');
    }

    // witness size (optional)
    const witnessSize =
      this.network.hasSegWit && Number.isFinite(size) && Number.isFinite(strippedsize)
        ? Math.max(0, size - strippedsize)
        : undefined;

    // Efficiency metrics
    const blockSizeEfficiency =
      Number.isFinite(this.network.maxBlockSize) && this.network.maxBlockSize > 0
        ? size / this.network.maxBlockSize
        : undefined;
    const witnessDataRatio = Number.isFinite(witnessSize) && size > 0 ? (witnessSize as number) / size : undefined;

    const out: Block = {
      height,
      hash,

      // ENHANCED SIZE FIELDS
      size,
      strippedsize,
      sizeWithoutWitnesses: strippedsize, // alias
      weight,
      vsize,
      witnessSize,
      // headerSize: 80,
      transactionsSize,
      version,
      versionHex,
      merkleroot,
      time,
      nonce,
      bits,
      difficulty,
      previousblockhash: universalBlock.previousblockhash,

      // only objects, no hex
      tx:
        Array.isArray(universalBlock.tx) && typeof universalBlock.tx[0] !== 'string'
          ? (universalBlock.tx as UniversalTransaction[]).map((t) => this.normalizeTransaction(t))
          : undefined,

      nTx: this.optNumber(universalBlock.nTx),

      // ADDITIONAL FIELDS
      fee: this.optNumber(universalBlock.fee),
      subsidy: this.optNumber(universalBlock.subsidy),
      miner: universalBlock.miner,
      pool: universalBlock.pool
        ? { poolName: universalBlock.pool.poolName ?? '', url: universalBlock.pool.url ?? '' }
        : undefined,

      // EFFICIENCY METRICS
      blockSizeEfficiency,
      witnessDataRatio,
    };

    return out;
  }

  public normalizeManyBlocks(universalBlocks: UniversalBlock[]): Block[] {
    return universalBlocks.map((b) => this.normalizeBlock(b));
  }

  // =======================
  // Transactions
  // =======================

  /**
   * REQUIRED by domain Transaction:
   * - txid, hash
   * - version, locktime
   * - size, strippedsize (aka sizeWithoutWitnesses), vsize, weight
   * - vin[], vout[]
   *
   * Notes:
   * - Accept both `strippedsize` and `strippedSize` from Universal (Hex path may use camel-case).
   * - `hash` fallback to `txid` if absent in Universal.
   * - feeRate is computed if fee & vsize present.
   */
  public normalizeTransaction(universalTx: UniversalTransaction): Transaction {
    if (!universalTx || typeof universalTx !== 'object') {
      throw new Error('Transaction object is required');
    }

    const txid = (universalTx.txid ?? '').toString();
    if (!txid) throw new Error('Transaction txid is required');

    const version = this.mustNumber(universalTx.version, 'tx.version');
    const locktime = this.mustNumber(universalTx.locktime, 'tx.locktime');

    const size = this.mustNumber(universalTx.size, 'tx.size');
    const weight = this.mustNumber(universalTx.weight, 'tx.weight');
    const vsize = this.mustNumber(universalTx.vsize, 'tx.vsize');

    // Accept both names: strippedsize | strippedSize (from HexTransformer)
    const strippedsizeSrc = (universalTx as any).strippedsize ?? (universalTx as any).strippedSize;
    const strippedsize = this.mustNumber(strippedsizeSrc, 'tx.strippedsize');

    if (!Array.isArray(universalTx.vin)) throw new Error(`Transaction vin is required for txid=${txid}`);
    if (!Array.isArray(universalTx.vout)) throw new Error(`Transaction vout is required for txid=${txid}`);

    const vin: Vin[] = universalTx.vin as any;
    const vout: Vout[] = universalTx.vout as any;

    // Optional fee & feeRate
    const fee = this.optNumber(universalTx.fee);
    const feeRate = Number.isFinite(fee) && vsize > 0 ? (fee as number) / vsize : undefined;

    const out: Transaction = {
      txid,
      hash: (universalTx.hash ?? txid).toString(),
      version,

      // ENHANCED SIZE FIELDS
      size,
      strippedsize,
      sizeWithoutWitnesses: strippedsize,
      vsize,
      weight,
      witnessSize: this.optNumber((universalTx as any).witnessSize),

      locktime,
      vin,
      vout,

      // NO hex here (service already decoded)
      blockhash: universalTx.blockhash,
      time: universalTx.time,
      blocktime: universalTx.blocktime,
      fee,
      feeRate,
      wtxid: universalTx.wtxid,
      depends: universalTx.depends,
      spentby: universalTx.spentby,
      bip125_replaceable: universalTx.bip125_replaceable,
    };

    return out;
  }

  public normalizeManyTransactions(universalTxs: UniversalTransaction[]): Transaction[] {
    return universalTxs.map((t) => this.normalizeTransaction(t));
  }

  private mustTxVsize(t: UniversalTransaction): number {
    const vs = Number(t.vsize);
    if (!Number.isFinite(vs)) throw new Error('tx.vsize is required to compute block.transactionsSize');
    return vs;
  }

  // =======================
  // Block stats
  // =======================

  /**
   * REQUIRED by domain BlockStats:
   * - height, blockhash, total_size
   *
   * Derived:
   * - total_witness_size = total_size - total_stripped_size (if both present)
   * - total_vsize = ceil(total_weight / 4) (if total_weight present)
   * - witness_ratio = witness_txs / txs (if both present)
   */
  public normalizeBlockStats(u: UniversalBlockStats): BlockStats {
    if (!u || typeof u !== 'object') throw new Error('BlockStats object is required');

    const height = this.mustNumber(u.height, 'stats.height');
    const blockhash = (u.blockhash ?? '').toString();
    if (!blockhash) throw new Error('stats.blockhash is required');

    const total_size = this.mustNumber(u.total_size, 'stats.total_size');

    const total_stripped_size = this.optNumber(u.total_stripped_size);
    const total_weight = this.optNumber(u.total_weight);
    const total_vsize = Number.isFinite(total_weight!) ? Math.ceil((total_weight as number) / 4) : undefined;

    const total_witness_size = Number.isFinite(total_stripped_size!)
      ? total_size - (total_stripped_size as number)
      : undefined;

    const txs = this.optNumber(u.txs);
    const witness_txs = this.optNumber(u.witness_txs);
    const witness_ratio =
      Number.isFinite(txs!) && (txs as number) > 0 && Number.isFinite(witness_txs!)
        ? (witness_txs as number) / (txs as number)
        : undefined;

    const out: BlockStats = {
      blockhash,
      height,

      // ENHANCED SIZE STATS
      total_size,
      total_stripped_size,
      total_witness_size,
      total_weight,
      total_vsize,

      total_fee: this.optNumber(u.total_fee),
      fee_rate_percentiles: Array.isArray(u.fee_rate_percentiles) ? u.fee_rate_percentiles : undefined,
      subsidy: this.optNumber(u.subsidy),
      total_out: this.optNumber(u.total_out),
      utxo_increase: this.optNumber(u.utxo_increase),
      utxo_size_inc: this.optNumber(u.utxo_size_inc),
      ins: this.optNumber(u.ins),
      outs: this.optNumber(u.outs),
      txs,

      // FEE STATS
      minfee: this.optNumber(u.minfee),
      maxfee: this.optNumber(u.maxfee),
      medianfee: this.optNumber(u.medianfee),
      avgfee: this.optNumber(u.avgfee),
      minfeerate: this.optNumber(u.minfeerate),
      maxfeerate: this.optNumber(u.maxfeerate),
      medianfeerate: this.optNumber(u.medianfeerate),
      avgfeerate: this.optNumber(u.avgfeerate),

      // TX SIZE STATS
      mintxsize: this.optNumber(u.mintxsize),
      maxtxsize: this.optNumber(u.maxtxsize),
      mediantxsize: this.optNumber(u.mediantxsize),
      avgtxsize: this.optNumber(u.avgtxsize),

      // WITNESS STATS
      witness_txs,
      witness_ratio,
    };

    return out;
  }

  public normalizeManyBlockStats(list: UniversalBlockStats[]): BlockStats[] {
    return list.map((s) => this.normalizeBlockStats(s));
  }

  // =======================
  // Mempool
  // =======================

  /**
   * REQUIRED by domain MempoolInfo:
   * - loaded, size, bytes, usage, total_fee, maxmempool, mempoolminfee, minrelaytxfee, unbroadcastcount
   *
   * No defaults; throw if anything is missing.
   */
  public normalizeMempoolInfo(u: UniversalMempoolInfo): MempoolInfo {
    if (!u || typeof u !== 'object') throw new Error('MempoolInfo object is required');

    const out: MempoolInfo = {
      loaded: Boolean(u.loaded),
      size: this.mustNumber(u.size, 'mempool.size'),
      bytes: this.mustNumber(u.bytes, 'mempool.bytes'),
      usage: this.mustNumber(u.usage, 'mempool.usage'),
      total_fee: this.mustNumber(u.total_fee, 'mempool.total_fee'),
      maxmempool: this.mustNumber(u.maxmempool, 'mempool.maxmempool'),
      mempoolminfee: this.mustNumber(u.mempoolminfee, 'mempool.mempoolminfee'),
      minrelaytxfee: this.mustNumber(u.minrelaytxfee, 'mempool.minrelaytxfee'),
      unbroadcastcount: this.mustNumber(u.unbroadcastcount, 'mempool.unbroadcastcount'),
    };

    return out;
  }

  /**
   * REQUIRED by domain MempoolTxMetadata (all fields except wtxid/unbroadcast optional in domain? No → many required):
   * - txid, size, vsize, weight, fee, modifiedfee, time, height
   * - depends[], descendantcount, descendantsize, descendantfees, ancestorcount, ancestorsize, ancestorfees
   * - fees.{base, modified, ancestor, descendant}, bip125_replaceable
   *
   * Throw if anything is missing/invalid.
   */
  public normalizeMempoolEntry(u: UniversalMempoolTxMetadata): MempoolTxMetadata {
    if (!u || typeof u !== 'object') throw new Error('Mempool entry object is required');

    const txid = (u.txid ?? '').toString();
    if (!txid) throw new Error('Mempool entry txid is required');

    const depends = Array.isArray(u.depends) ? u.depends : [];
    const fees = u.fees ?? {};

    const out: MempoolTxMetadata = {
      // Basic
      txid,
      wtxid: u.wtxid,
      vsize: this.mustNumber(u.vsize, 'mempool.vsize'),
      weight: this.mustNumber(u.weight, 'mempool.weight'),
      fee: this.mustNumber(u.fee, 'mempool.fee'),
      modifiedfee: this.mustNumber(u.modifiedfee, 'mempool.modifiedfee'),
      time: this.mustNumber(u.time, 'mempool.time'),
      height: this.mustNumber(u.height, 'mempool.height'),

      // Family
      depends,
      descendantcount: this.mustNumber(u.descendantcount, 'mempool.descendantcount'),
      descendantsize: this.mustNumber(u.descendantsize, 'mempool.descendantsize'),
      descendantfees: this.mustNumber(u.descendantfees, 'mempool.descendantfees'),
      ancestorcount: this.mustNumber(u.ancestorcount, 'mempool.ancestorcount'),
      ancestorsize: this.mustNumber(u.ancestorsize, 'mempool.ancestorsize'),
      ancestorfees: this.mustNumber(u.ancestorfees, 'mempool.ancestorfees'),

      // Fee structure
      fees: {
        base: this.mustNumber(fees.base, 'mempool.fees.base'),
        modified: this.mustNumber(fees.modified, 'mempool.fees.modified'),
        ancestor: this.mustNumber(fees.ancestor, 'mempool.fees.ancestor'),
        descendant: this.mustNumber(fees.descendant, 'mempool.fees.descendant'),
      },

      // Flags
      bip125_replaceable: Boolean(u.bip125_replaceable),

      // Optional
      unbroadcast: u.unbroadcast,
    };

    return out;
  }

  public normalizeMempoolEntryMap(m: Record<string, UniversalMempoolTxMetadata>): Record<string, MempoolTxMetadata> {
    const out: Record<string, MempoolTxMetadata> = {};
    for (const [k, v] of Object.entries(m)) {
      out[k] = this.normalizeMempoolEntry(v);
    }
    return out;
  }
}
