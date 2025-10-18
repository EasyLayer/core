import type { UniversalMempoolInfo, UniversalMempoolTxMetadata, UniversalTransaction } from './interfaces';
import { BaseProvider } from './base.provider';
import { UniversalTransformer } from './universal-transformer';

/**
 * MempoolProvider
 *
 * Responsibilities:
 * - Fetch mempool info and normalize units to smallest per network.
 * - Fetch batch mempool entries preserving input order.
 * - Fetch getrawmempool(true) map and normalize values.
 * - Fetch transactions (RPC or hex path) and normalize via UniversalTransformer.
 *
 * Order guarantees:
 * - getMempoolEntries(txids): results[i] corresponds to txids[i].
 * - getRawMempool(true): returns Record<txid, UniversalMempoolTxMetadata> (keyed by txid).
 */
export class MempoolProvider extends BaseProvider {
  // ===== TRANSACTIONS (shared with NetworkProvider pattern) =====

  async getManyTransactionsByTxids(txids: string[], verbosity: 1 | 2 = 2): Promise<(UniversalTransaction | null)[]> {
    if (!Array.isArray(txids) || txids.length === 0) return [];

    if (this.transportType === 'rpc') {
      const raws = await this.transport.getRawTransactionsByTxids(txids, verbosity);
      return raws.map((raw) => (raw ? UniversalTransformer.normalizeRpcTransaction(raw, this.network) : null));
    }
    return this.getManyTransactionsHexByTxids(txids);
  }

  async getManyTransactionsHexByTxids(txids: string[]): Promise<(UniversalTransaction | null)[]> {
    if (!Array.isArray(txids) || txids.length === 0) return [];
    const hexes = await this.transport.getRawTransactionsHexByTxids(txids);
    return hexes.map((hex) => {
      if (typeof hex !== 'string') return null;
      try {
        const u8 = Buffer.from(hex, 'hex');
        return UniversalTransformer.parseTxBytes(u8, this.network);
      } catch {
        return null;
      }
    });
  }

  // ===== MEMPOOL INFO =====

  async getMempoolInfo(): Promise<UniversalMempoolInfo> {
    const raw = await this.transport.getMempoolInfo();
    return UniversalTransformer.normalizeRpcMempoolInfo(raw, this.network);
  }

  // ===== MEMPOOL ENTRIES =====

  /**
   * ORDER GUARANTEE: results[i] corresponds to txids[i]; null for missing.
   * RPC calls: O(n) getmempoolentry batched by transport.
   */
  async getMempoolEntries(txids: string[]): Promise<(UniversalMempoolTxMetadata | null)[]> {
    if (!Array.isArray(txids) || txids.length === 0) return [];
    const raws: any[] = await this.transport.getMempoolEntries(txids);
    return txids.map((txid, i) => {
      const e = raws?.[i];
      if (!e || typeof e !== 'object') return null;
      return UniversalTransformer.normalizeRpcMempoolEntry(e, this.network, txid);
    });
  }

  /**
   * getrawmempool(false) → string[]
   * getrawmempool(true)  → Record<txid, UniversalMempoolTxMetadata>
   */
  async getRawMempool(verbose: true): Promise<Record<string, UniversalMempoolTxMetadata>>;
  async getRawMempool(verbose?: false): Promise<string[]>;
  async getRawMempool(verbose: boolean = false): Promise<any> {
    if (!verbose) {
      const list = await this.transport.getRawMempool(false);
      return Array.isArray(list) ? list : [];
    }

    const map = await this.transport.getMempoolVerbose();
    if (!map || typeof map !== 'object') return {};

    const out: Record<string, UniversalMempoolTxMetadata> = {};
    for (const [txid, e] of Object.entries(map as Record<string, any>)) {
      out[txid] = UniversalTransformer.normalizeRpcMempoolEntry(e, this.network, txid);
    }
    return out;
  }

  // ===== FEES =====

  async estimateSmartFee(
    confTarget: number,
    estimateMode: 'ECONOMICAL' | 'CONSERVATIVE' = 'CONSERVATIVE'
  ): Promise<any> {
    return this.transport.estimateSmartFee(confTarget, estimateMode);
  }

  async estimateSmartFeeSatVb(
    confTarget: number,
    estimateMode: 'ECONOMICAL' | 'CONSERVATIVE' = 'CONSERVATIVE'
  ): Promise<{ sat_per_vb?: number; blocks?: number; errors?: string[] }> {
    const raw = await this.transport.estimateSmartFee(confTarget, estimateMode);
    return UniversalTransformer.normalizeRpcSmartFee(raw, this.network);
  }

  // ===== CHAIN STATE PASSTHROUGH =====

  async getCurrentBlockHeight(): Promise<number> {
    const height = await this.transport.getBlockHeight();
    if (typeof height !== 'number' || height < 0) {
      throw new Error('Failed to get block height: invalid response from transport');
    }
    return height;
  }
}
