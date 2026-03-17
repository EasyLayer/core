import type { UniversalBlock, UniversalBlockStats, UniversalTransaction } from './interfaces';
import { BaseProvider } from './base.provider';
import { UniversalTransformer } from './universal-transformer';

/**
 * NetworkProvider
 *
 * Responsibilities:
 * - Fetch blocks by height/hash and return UniversalBlock, preserving input order.
 * - Fetch transactions by txids and return UniversalTransaction, preserving input order.
 * - Fetch block stats and normalize to UniversalBlockStats.
 * - Subscribe to new blocks via P2P (bytes → parse).
 *
 * RPC usage and complexity:
 * - getManyBlocksByHeights: O(n) calls to getblockhash + O(k) to getblock (k=valid hashes).
 * - getManyBlocksByHashes: O(n) to getblock (verbosity 1|2) OR O(n) hex path.
 * - getManyTransactionsByTxids: O(n) getrawtransaction (verbosity 1|2) OR O(n) hex path.
 * - All "getMany*" methods preserve order: results[i] corresponds to inputs[i].
 */
export class NetworkProvider extends BaseProvider {
  /**
   * Subscribe to raw new blocks via P2P (ZMQ/peers). Parses bytes → UniversalBlock.
   * RPC calls: 0 (streaming). Time: O(1) per block, parsing ~O(#tx + bytes).
   */
  subscribeToNewBlocks(
    callback: (block: UniversalBlock) => void,
    onError?: (err: Error) => void
  ): { unsubscribe: () => void } {
    if (typeof (this.transport as any).subscribeToNewBlocks !== 'function') {
      throw new Error(
        `Provider "${(this.transport as any).uniqName}": subscribeToNewBlocks is not supported by transport type "${(this.transport as any).type}"`
      );
    }

    return this.transport.subscribeToNewBlocks!((blockData: Buffer | Uint8Array) => {
      try {
        // Normalize to Uint8Array without copying when possible
        const u8 =
          typeof Buffer !== 'undefined' && (blockData as any).buffer
            ? new Uint8Array(
                (blockData as any).buffer,
                (blockData as any).byteOffset ?? 0,
                (blockData as any).byteLength ?? (blockData as any).length
              )
            : (blockData as Uint8Array);

        // Parse bytes → UniversalBlock (height may be undefined on raw stream)
        const parsed = UniversalTransformer.parseBlockBytes(u8, this.network);
        callback(parsed as UniversalBlock);
      } catch (err) {
        // Wrap with context so the caller knows where the failure occurred
        const wrapped =
          err instanceof Error
            ? new Error(
                `Provider "${(this.transport as any).uniqName}": failed to parse incoming block bytes: ${err.message}`
              )
            : new Error(
                `Provider "${(this.transport as any).uniqName}": failed to parse incoming block bytes: ${String(err)}`
              );
        onError?.(wrapped);
      }
    }, onError);
  }

  // ===== BASIC CHAIN STATE =====

  async getBlockHeight(): Promise<number> {
    return await this.transport.getBlockHeight();
  }

  // ===== BLOCKS BY HEIGHT =====

  async getManyBlocksByHeights(heights: number[], verbosity: 1 | 2 = 1): Promise<(UniversalBlock | null)[]> {
    const hashes = await this.getManyBlockHashesByHeights(heights);
    const validHashes = hashes.filter((h): h is string => !!h);
    if (validHashes.length === 0) return new Array(heights.length).fill(null);

    const blocks = await this.getManyBlocksByHashes(validHashes, verbosity);

    const hashToHeight = new Map<string, number>();
    hashes.forEach((h, i) => {
      if (h) hashToHeight.set(h, heights[i]!);
    });

    const map = new Map<string, UniversalBlock | null>();
    validHashes.forEach((hash, idx) => {
      const b = blocks[idx] || null;
      if (b && (b as any).height == null) {
        const h = hashToHeight.get(hash);
        if (typeof h === 'number') (b as any).height = h;
      }
      map.set(hash, b);
    });

    return hashes.map((hash) => (hash ? map.get(hash) || null : null));
  }

  async getManyBlocksHexByHeights(heights: number[]): Promise<(UniversalBlock | null)[]> {
    const hashes = await this.getManyBlockHashesByHeights(heights);
    const validHashes = hashes.filter((h): h is string => !!h);
    if (validHashes.length === 0) return new Array(heights.length).fill(null);

    const hexBlocks = await this.transport.requestHexBlocks(validHashes);
    const parsed: (UniversalBlock | null)[] = hexBlocks.map((buffer) => {
      if (!buffer) return null;
      try {
        const u8 =
          typeof Buffer !== 'undefined' && (buffer as any).buffer
            ? new Uint8Array(
                (buffer as any).buffer,
                (buffer as any).byteOffset ?? 0,
                (buffer as any).length ?? (buffer as any).byteLength
              )
            : (buffer as Uint8Array);
        return UniversalTransformer.parseBlockBytes(u8, this.network);
      } catch {
        return null;
      }
    });

    const hashToHeight = new Map<string, number>();
    hashes.forEach((h, i) => {
      if (h) hashToHeight.set(h, heights[i]!);
    });

    const map = new Map<string, UniversalBlock | null>();
    validHashes.forEach((hash, idx) => {
      const b = parsed[idx] || null;
      if (b && (b as any).height == null) {
        const h = hashToHeight.get(hash);
        if (typeof h === 'number') (b as any).height = h;
      }
      map.set(hash, b);
    });

    return hashes.map((hash) => (hash ? map.get(hash) || null : null));
  }

  // ===== BLOCKS BY HASH =====

  async getManyBlocksByHashes(hashes: string[], verbosity: 1 | 2 = 1): Promise<(UniversalBlock | null)[]> {
    if (!Array.isArray(hashes) || hashes.length === 0) return [];

    if (this.transportType === 'rpc') {
      if (verbosity === 1 || verbosity === 2) {
        const raws = await this.transport.getRawBlocksByHashesVerbose(hashes, verbosity);
        return raws.map((raw) => (raw ? UniversalTransformer.normalizeRpcBlock(raw, this.network) : null));
      }
    }

    const hexBlockBuffers = await this.transport.requestHexBlocks(hashes);
    return hexBlockBuffers.map((buffer: any) => {
      if (!buffer) return null;
      try {
        const u8 =
          typeof Buffer !== 'undefined' && (buffer as any).buffer
            ? new Uint8Array(
                (buffer as any).buffer,
                (buffer as any).byteOffset ?? 0,
                (buffer as any).length ?? (buffer as any).byteLength
              )
            : (buffer as Uint8Array);
        return UniversalTransformer.parseBlockBytes(u8, this.network) as UniversalBlock;
      } catch {
        return null;
      }
    });
  }

  async getManyBlocksHexByHashes(hashes: string[]): Promise<(UniversalBlock | null)[]> {
    const hexBlockBuffers = await this.transport.requestHexBlocks(hashes);
    return hexBlockBuffers.map((buffer: any) => {
      if (!buffer) return null;
      try {
        const u8 =
          typeof Buffer !== 'undefined' && (buffer as any).buffer
            ? new Uint8Array(
                (buffer as any).buffer,
                (buffer as any).byteOffset ?? 0,
                (buffer as any).length ?? (buffer as any).byteLength
              )
            : (buffer as Uint8Array);
        return UniversalTransformer.parseBlockBytes(u8, this.network) as UniversalBlock;
      } catch {
        return null;
      }
    });
  }

  // ===== BLOCK STATS =====

  async getManyBlocksStatsByHeights(heights: number[]): Promise<(UniversalBlockStats | null)[]> {
    const hashes = await this.getManyBlockHashesByHeights(heights);
    const validHashes = hashes.filter((h): h is string => !!h);
    if (validHashes.length === 0) return new Array(heights.length).fill(null);

    const stats = await this.getManyBlocksStatsByHashes(validHashes);

    const map = new Map<string, UniversalBlockStats | null>();
    validHashes.forEach((hash, idx) => {
      map.set(hash, stats[idx] || null);
    });

    return hashes.map((hash) => (hash ? map.get(hash) || null : null));
  }

  async getManyBlocksStatsByHashes(hashes: string[]): Promise<(UniversalBlockStats | null)[]> {
    if (!Array.isArray(hashes) || hashes.length === 0) return [];
    const raws = await this.transport.getBlockStatsByHashes(hashes);
    return raws.map((raw) => (raw ? UniversalTransformer.normalizeRpcBlockStats(raw) : null));
  }

  // ===== TRANSACTIONS =====

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

  // ===== HELPERS/PASSTHROUGH =====

  async getManyBlockHashesByHeights(heights: number[]): Promise<(string | null)[]> {
    return this.transport.getManyBlockHashesByHeights(heights);
  }

  async getHeightsByHashes(hashes: string[]): Promise<(number | null)[]> {
    return this.transport.getHeightsByHashes(hashes);
  }

  async getBlockchainInfo(): Promise<any> {
    const [info] = [await this.transport.getBlockchainInfo()];
    return info ?? {};
  }

  async getNetworkInfo(): Promise<any> {
    const [info] = [await this.transport.getNetworkInfo()];
    return info ?? {};
  }

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

  // ===== P2P SPECIFIC METHODS =====

  /**
   * Initialize P2P internals and optionally wait for header sync.
   * RPC calls: 0. Time: depends on transport's header sync.
   */
  async initializeP2P(options: { waitForHeaderSync?: boolean; headerSyncTimeout?: number } = {}): Promise<void> {
    if (this.transportType !== 'p2p') return;

    const p2p = this.transport as any;
    if (options.waitForHeaderSync && typeof p2p.waitForHeaderSync === 'function') {
      await p2p.waitForHeaderSync(options.headerSyncTimeout ?? 300_000);
    }
  }

  /**
   * Report P2P status (header sync flags/progress) if supported by transport.
   * RPC calls: 0. Time: O(1).
   */
  async getP2PStatus(): Promise<{
    isP2P: boolean;
    headerSyncComplete?: boolean;
    syncProgress?: { synced: number; total: number; percentage: number };
  }> {
    if (this.transportType !== 'p2p') return { isP2P: false };

    const p2p = this.transport as any;
    try {
      const [headerSyncComplete, syncProgress] = await Promise.all([
        typeof p2p.isHeaderSyncComplete === 'function' ? p2p.isHeaderSyncComplete() : false,
        typeof p2p.getHeaderSyncProgress === 'function'
          ? p2p.getHeaderSyncProgress()
          : { synced: 0, total: 0, percentage: 0 },
      ]);

      return {
        isP2P: true,
        headerSyncComplete,
        syncProgress,
      };
    } catch {
      // Fallback: P2P active but no extra status
      return { isP2P: true };
    }
  }
}
