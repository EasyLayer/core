import type { UniversalMempoolInfo, UniversalTransaction, UniversalMempoolTxMetadata } from './interfaces';
import { HexTransformer } from './hex-transformer';
import { BaseProvider } from './base.provider';

/** Unit helpers (coin → smallest units; coin/kvB → smallest-unit per vB) */
function unitFactor(decimals: number) {
  return Math.pow(10, Math.max(0, decimals | 0));
}
function toSmallestUnits(valueInCoin: any, factor: number): number {
  const n = Number(valueInCoin);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * factor);
}
function toSmallestPerVb(valueInCoinPerKvB: any, factor: number): number {
  const n = Number(valueInCoinPerKvB);
  if (!Number.isFinite(n)) return 0;
  return Math.round((n * factor) / 1000); // kvB -> vB
}

/**
 * Mempool Provider for mempool-specific operations
 *
 * Responsibilities:
 * - Mempool transaction retrieval and parsing
 * - Mempool information and statistics
 * - Raw mempool data access
 * - Fee estimation
 *
 * Currently works with RPC transport only (P2P support planned for future)
 * Supports Bitcoin-compatible chains (BTC, BCH, DOGE, LTC) via network config
 * Designed for multi-provider strategies (parallel, round-robin, fastest)
 */
export class MempoolProvider extends BaseProvider {
  /**
   * Estimate fee for target confirmation
   * Node calls: 1 (estimatesmartfee)
   * Time complexity: O(1)
   *
   * @param confTarget Target number of blocks for confirmation
   * @param estimateMode Estimation mode (ECONOMICAL or CONSERVATIVE)
   * @returns Fee estimation result
   */
  async estimateSmartFee(
    confTarget: number,
    estimateMode: 'ECONOMICAL' | 'CONSERVATIVE' = 'CONSERVATIVE'
  ): Promise<any> {
    return this.transport.estimateSmartFee(confTarget, estimateMode);
  }

  /**
   * Get current block height
   * Node calls: 1 (getblockcount)
   * Time complexity: O(1)
   */
  async getCurrentBlockHeight(): Promise<number> {
    const height = await this.transport.getBlockHeight();
    if (typeof height !== 'number' || height < 0) {
      throw new Error('Failed to get block height: invalid response from transport');
    }
    return height;
  }

  /**
   * getRawMempool(verbose=false) -> string[]
   * getRawMempool(verbose=true)  -> Record<txid, UniversalMempoolTxMetadata>
   */
  async getRawMempool(verbose: true): Promise<Record<string, UniversalMempoolTxMetadata>>;
  async getRawMempool(verbose?: false): Promise<string[]>;
  async getRawMempool(verbose: boolean = false): Promise<any> {
    if (!verbose) {
      const list = await this.transport.getRawMempool(false);
      return Array.isArray(list) ? list : [];
    }

    const raw = await this.transport.getRawMempool(true); // Record<string, any>
    const out: Record<string, UniversalMempoolTxMetadata> = {};
    const factor = unitFactor(this.network.nativeCurrencyDecimals);

    for (const [txid, entry] of Object.entries(raw || {})) {
      const e: any = entry || {};

      const baseCoin =
        e?.fees?.modified ?? e?.fees?.base ?? e?.fees?.ancestor ?? e?.fees?.descendant ?? e?.modifiedfee ?? e?.fee ?? 0;

      out[txid] = {
        txid,
        wtxid: e.wtxid,
        size: Number(e.size) || 0,
        vsize: Number(e.vsize) || 0,
        weight: Number(e.weight) || 0,

        fee: toSmallestUnits(e.fee ?? baseCoin, factor),
        modifiedfee: toSmallestUnits(e.modifiedfee ?? e?.fees?.modified ?? baseCoin, factor),
        time: Number(e.time) || 0,
        height: Number(e.height) || 0,

        depends: Array.isArray(e.depends) ? e.depends : [],
        descendantcount: Number(e.descendantcount) || 0,
        descendantsize: Number(e.descendantsize) || 0,
        descendantfees: toSmallestUnits(e.descendantfees, factor),
        ancestorcount: Number(e.ancestorcount) || 0,
        ancestorsize: Number(e.ancestorsize) || 0,
        ancestorfees: toSmallestUnits(e.ancestorfees, factor),

        fees: {
          base: toSmallestUnits(e?.fees?.base ?? baseCoin, factor),
          modified: toSmallestUnits(e?.fees?.modified ?? baseCoin, factor),
          ancestor: toSmallestUnits(e?.fees?.ancestor ?? 0, factor),
          descendant: toSmallestUnits(e?.fees?.descendant ?? 0, factor),
        },

        bip125_replaceable: !!e.bip125_replaceable,
        unbroadcast: !!e.unbroadcast,
      };
    }

    return out;
  }

  // ----- Mempool info -----

  async getMempoolInfo(): Promise<UniversalMempoolInfo> {
    const raw: any = await this.transport.getMempoolInfo();
    const factor = unitFactor(this.network.nativeCurrencyDecimals);

    return {
      loaded: !!raw?.loaded,
      size: Number(raw?.size) || 0,
      bytes: Number(raw?.bytes) || 0,
      usage: Number(raw?.usage) || 0,
      total_fee: toSmallestUnits(raw?.total_fee, factor),
      maxmempool: Number(raw?.maxmempool) || 0,
      mempoolminfee: toSmallestPerVb(raw?.mempoolminfee, factor),
      minrelaytxfee: toSmallestPerVb(raw?.minrelaytxfee, factor),
      unbroadcastcount: Number(raw?.unbroadcastcount) || 0,
    };
  }

  // ----- Mempool entries -----

  /**
   * ORDER GUARANTEE: results[i] corresponds to txids[i]; null for missing/failed.
   */
  async getMempoolEntries(txids: string[]): Promise<(UniversalMempoolTxMetadata | null)[]> {
    if (!Array.isArray(txids) || txids.length === 0) return [];
    const raws = await this.transport.getMempoolEntries(txids); // (any | null)[]
    const factor = unitFactor(this.network.nativeCurrencyDecimals);

    return raws.map((eRaw: any, i) => {
      if (!eRaw || typeof eRaw !== 'object') return null;
      const e = eRaw;

      const txid = txids[i]!;
      const baseCoin =
        e?.fees?.modified ?? e?.fees?.base ?? e?.fees?.ancestor ?? e?.fees?.descendant ?? e?.modifiedfee ?? e?.fee ?? 0;

      const meta: UniversalMempoolTxMetadata = {
        txid,
        wtxid: e.wtxid,
        size: Number(e.size) || 0,
        vsize: Number(e.vsize) || 0,
        weight: Number(e.weight) || 0,

        fee: toSmallestUnits(e.fee ?? baseCoin, factor),
        modifiedfee: toSmallestUnits(e.modifiedfee ?? e?.fees?.modified ?? baseCoin, factor),
        time: Number(e.time) || 0,
        height: Number(e.height) || 0,

        depends: Array.isArray(e.depends) ? e.depends : [],
        descendantcount: Number(e.descendantcount) || 0,
        descendantsize: Number(e.descendantsize) || 0,
        descendantfees: toSmallestUnits(e.descendantfees, factor),
        ancestorcount: Number(e.ancestorcount) || 0,
        ancestorsize: Number(e.ancestorsize) || 0,
        ancestorfees: toSmallestUnits(e.ancestorfees, factor),

        fees: {
          base: toSmallestUnits(e?.fees?.base ?? baseCoin, factor),
          modified: toSmallestUnits(e?.fees?.modified ?? baseCoin, factor),
          ancestor: toSmallestUnits(e?.fees?.ancestor ?? 0, factor),
          descendant: toSmallestUnits(e?.fees?.descendant ?? 0, factor),
        },

        bip125_replaceable: !!e.bip125_replaceable,
        unbroadcast: !!e.unbroadcast,
      };

      return meta;
    });
  }

  // ----- Transactions -----

  /**
   * Decoded path (verbosity=1):
   * ORDER GUARANTEE: results[i] corresponds to txids[i]; null for missing.
   */
  async getManyTransactionsByTxids(txids: string[], verbosity: number = 1): Promise<(UniversalTransaction | null)[]> {
    if (!Array.isArray(txids) || txids.length === 0) return [];
    const raws: any[] = await this.transport.getRawTransactionsByTxids(txids, 1 as 1);

    return raws.map((txRaw: any) => {
      if (!txRaw || typeof txRaw !== 'object') return null;

      const vin = Array.isArray(txRaw.vin)
        ? txRaw.vin.map((v: any) => ({ txid: v.txid, vout: v.vout, sequence: v.sequence }))
        : [];

      const vout = Array.isArray(txRaw.vout)
        ? txRaw.vout.map((o: any) => ({
            value: Number(o.value) || 0,
            n: Number(o.n) || 0,
            scriptPubKey: o?.scriptPubKey
              ? { type: o.scriptPubKey.type, addresses: o.scriptPubKey.addresses, hex: o.scriptPubKey.hex }
              : undefined,
          }))
        : [];

      const utx: UniversalTransaction = {
        txid: txRaw.txid,
        hash: txRaw.hash,
        version: txRaw.version,
        size: Number(txRaw.size) || 0,
        // strippedsize: Number(txRaw.strippedsize) || undefined,
        // sizeWithoutWitnesses: txRaw.sizeWithoutWitnesses ? Number(txRaw.sizeWithoutWitnesses) : undefined,
        vsize: Number(txRaw.vsize) || 0,
        weight: Number(txRaw.weight) || 0,
        locktime: Number(txRaw.locktime) || 0,
        vin,
        vout,
        fee: typeof txRaw.fee === 'number' ? txRaw.fee : undefined,
        wtxid: txRaw.wtxid,
        bip125_replaceable: !!txRaw.bip125_replaceable,
      };

      return utx;
    });
  }

  /**
   * Hex path (verbosity=false) + HexTransformer:
   * ORDER GUARANTEE: results[i] corresponds to txids[i]; null for missing/parse failure.
   */
  async getManyTransactionsHexByTxids(txids: string[]): Promise<(UniversalTransaction | null)[]> {
    if (!Array.isArray(txids) || txids.length === 0) return [];
    const hexResults: (string | null)[] = await this.transport.getRawTransactionsHexByTxids(txids);

    return hexResults.map((hex) => {
      if (typeof hex !== 'string') return null;
      try {
        const u8 = Buffer.from(hex, 'hex');
        const parsed = HexTransformer.parseTxBytes(u8, this.network);
        return parsed as UniversalTransaction;
      } catch {
        return null;
      }
    });
  }
}
