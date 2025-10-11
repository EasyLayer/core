import type { UniversalBlock, UniversalTransaction, UniversalBlockStats } from './interfaces';
import { BaseProvider } from './base.provider';
import { HexTransformer } from './hex-transformer';

/**
 * Network Provider for blockchain operations
 *
 * Responsibilities:
 * - Block retrieval by height/hash with guaranteed height information
 * - Transaction retrieval and parsing
 * - Block statistics retrieval
 * - Real-time block subscriptions
 *
 * Works with both RPC and P2P transports through unified interface
 * Supports Bitcoin-compatible chains (BTC, BCH, DOGE, LTC) via network config
 * All methods preserve order and handle missing data gracefully with nulls
 */
export class NetworkProvider extends BaseProvider {
  /**
   * Subscribe to new blocks with automatic parsing
   * Node calls: 0 (real-time messages from transport)
   * Memory: No block storage - immediate callback execution
   *
   * @param callback Function to call when new block arrives
   * @returns Subscription object with unsubscribe method
   */
  subscribeToNewBlocks(
    callback: (block: UniversalBlock) => void,
    onError?: (err: Error) => void
  ): { unsubscribe: () => void } {
    if (typeof this.transport.subscribeToNewBlocks !== 'function') {
      throw new Error('Transport does not support block subscriptions');
    }
    // Parse from bytes to avoid huge hex strings in memory
    return this.transport.subscribeToNewBlocks((blockData: Buffer | Uint8Array) => {
      try {
        const u8 =
          typeof Buffer !== 'undefined' && typeof (blockData as any).buffer !== 'undefined'
            ? new Uint8Array(
                (blockData as any).buffer,
                (blockData as any).byteOffset ?? 0,
                (blockData as any).byteLength ?? (blockData as any).length
              )
            : (blockData as Uint8Array);
        const parsedBlock = HexTransformer.parseBlockBytes(u8, this.network);
        // Do NOT attach .hex to the block object to avoid memory bloat
        callback(parsedBlock as UniversalBlock);
      } catch (err) {
        onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    }, onError);
  }

  // ===== BASIC CHAIN STATE =====

  /**
   * Get current best block height
   * Node calls: 1 (getblockcount for RPC, cached for P2P)
   */
  async getBlockHeight(): Promise<number> {
    return await this.transport.getBlockHeight();
  }

  /**
   * Get multiple block hashes by heights
   * Node calls: 1 (batch getblockhash for all heights)
   * Time complexity: O(k) where k = number of heights
   *
   * @param heights Array of block heights
   * @returns Array of hashes in same order as input, null for missing blocks
   */
  async getManyBlockHashesByHeights(heights: number[]): Promise<(string | null)[]> {
    return await this.transport.getManyBlockHashesByHeights(heights);
  }

  // ===== HEX (bytes) METHODS =====

  /**
   * Get multiple blocks parsed from hex as Universal objects
   * Node calls: 1 (batch getblock with verbosity=0 for all hashes, or P2P GetData)
   * Time complexity: O(k) where k = number of blocks requested
   *
   * @param hashes Array of block hashes
   * @returns Array of blocks in same order as input, null for missing blocks
   */
  async getManyBlocksHexByHashes(hashes: string[]): Promise<(UniversalBlock | null)[]> {
    try {
      const hexBlockBuffers = await this.transport.requestHexBlocks(hashes);

      return await Promise.all(
        hexBlockBuffers.map(async (buffer: any) => {
          if (!buffer) return null;
          try {
            const u8 =
              typeof Buffer !== 'undefined' && Buffer.isBuffer(buffer)
                ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
                : (buffer as Uint8Array);
            // Parse directly from bytes; do NOT create hex strings
            const parsedBlock = HexTransformer.parseBlockBytes(u8, this.network);
            // Do NOT attach .hex = ...
            return parsedBlock as UniversalBlock;
          } catch {
            return null;
          }
        })
      );
    } catch {
      return new Array(hashes.length).fill(null);
    }
  }

  /**
   * Get multiple blocks parsed from hex by heights
   * Node calls: 2 (batch getblockhash + batch getblock for valid hashes)
   * Time complexity: O(k) where k = number of heights
   *
   * @param heights Array of block heights
   * @returns Array of blocks in same order as input heights, null for missing blocks
   */
  async getManyBlocksHexByHeights(heights: number[]): Promise<(UniversalBlock | null)[]> {
    const hashes = await this.getManyBlockHashesByHeights(heights);
    const validHashes = hashes.filter((hash): hash is string => hash !== null);

    if (validHashes.length === 0) {
      return new Array(heights.length).fill(null);
    }

    const hexBlocks = await this.getManyBlocksHexByHashes(validHashes);

    const hashToBlock = new Map<string, UniversalBlock | null>();
    validHashes.forEach((hash, index) => {
      hashToBlock.set(hash, hexBlocks[index] || null);
    });

    return hashes.map((hash, index) => {
      if (hash === null) return null;
      const block = hashToBlock.get(hash) || null;
      if (block !== null) {
        // Ensure height is set if missing
        if (typeof (block as any).height !== 'number') {
          (block as any).height = heights[index];
        }
      }
      return block;
    });
  }

  /**
   * Get multiple blocks as structured objects by hashes
   * Node calls:
   *   - RPC: batch getblock <hash> <verbosity>
   *   - P2P: fall back to hex parsing (verbosity=1 only)
   */
  async getManyBlocksByHashes(hashes: string[], verbosity: number = 1): Promise<(UniversalBlock | null)[]> {
    if (this.transport.type === 'rpc') {
      const raws = await this.transport.getRawBlocksByHashesVerbose(hashes, verbosity as 1 | 2);
      return raws.map((rawBlock: any) => (rawBlock === null ? null : this.normalizeRawBlock(rawBlock)));
    }

    // P2P path: only bytes available — parse as hex form
    return this.getManyBlocksHexByHashes(hashes);
  }

  /**
   * Get multiple blocks as structured objects by heights
   * Node calls: 2 (batch getblockhash + batch getblock for valid hashes)
   * Time complexity: O(k) where k = number of heights
   *
   * @param heights Array of block heights
   * @param verbosity Verbosity level (1=with tx hashes, 2=with full tx objects)
   * @returns Array of blocks in same order as input heights, null for missing blocks
   */
  async getManyBlocksByHeights(heights: number[], verbosity: number = 1): Promise<(UniversalBlock | null)[]> {
    const blocksHashes = await this.getManyBlockHashesByHeights(heights);
    const validHashes = blocksHashes.filter((hash): hash is string => !!hash);

    if (validHashes.length === 0) {
      return new Array(heights.length).fill(null);
    }

    const blocks = await this.getManyBlocksByHashes(validHashes, verbosity);

    const map = new Map<string, UniversalBlock | null>();
    validHashes.forEach((hash, idx) => {
      const b = blocks[idx] || null;
      if (b) (b as any).height ??= heights[blocksHashes.indexOf(hash)];
      map.set(hash, b);
    });

    return blocksHashes.map((hash) => (hash ? map.get(hash) || null : null));
  }

  /**
   * Get block stats by hashes (RPC only); P2P throws.
   * Node calls: 1 (batch getblockstats for all hashes)
   */
  async getManyBlocksStatsByHashes(hashes: string[]): Promise<(UniversalBlockStats | null)[]> {
    const results = await this.transport.getBlockStatsByHashes(hashes);
    return results.map((raw: any) => (raw ? this.normalizeRawBlockStats(raw) : null));
  }

  /**
   * Get block stats by heights
   * Node calls: 2 (batch getblockhash + batch getblockstats, with genesis handling)
   */
  async getManyBlocksStatsByHeights(heights: number[]): Promise<(UniversalBlockStats | null)[]> {
    const blocksHashes = await this.getManyBlockHashesByHeights(heights);
    const validHashes = blocksHashes.filter((hash): hash is string => !!hash);

    if (validHashes.length === 0) {
      return new Array(heights.length).fill(null);
    }

    const blocks = await this.getManyBlocksStatsByHashes(validHashes);

    const hashToStats = new Map<string, UniversalBlockStats | null>();
    validHashes.forEach((hash, index) => {
      hashToStats.set(hash, blocks[index] || null);
    });

    return blocksHashes.map((hash) => (hash ? hashToStats.get(hash) || null : null));
  }

  /**
   * Get only block heights by hashes for the *current* transport.
   * Delegates to transport (P2P: local header index; RPC: getblockheader).
   * Any failure propagates up.
   */
  async getHeightsByHashes(hashes: string[]): Promise<(number | null)[]> {
    return this.transport.getHeightsByHashes(hashes);
  }

  // ===== TRANSACTION METHODS =====

  /**
   * Get multiple transactions as structured objects
   * Node calls: 1 (batch getrawtransaction <verbosity=1|2>)
   */
  async getManyTransactionsByTxids(txids: string[], verbosity: number = 1): Promise<(UniversalTransaction | null)[]> {
    const results = await this.transport.getRawTransactionsByTxids(txids, verbosity as 1 | 2);

    return results.map((rawTx: any) => {
      if (rawTx === null) return null;

      try {
        return this.normalizeRawTransaction(rawTx);
      } catch {
        return null;
      }
    });
  }

  /**
   * Get multiple transactions parsed from hex
   * Node calls: 1 (batch getrawtransaction with verbosity=0)
   */
  async getManyTransactionsHexByTxids(txids: string[]): Promise<(UniversalTransaction | null)[]> {
    const hexResults = await this.transport.getRawTransactionsHexByTxids(txids);

    return hexResults.map((hex) => {
      if (hex === null) return null;

      try {
        const u8 = Buffer.from(hex, 'hex');
        const parsedTx = HexTransformer.parseTxBytes(u8, this.network);
        // Do NOT attach tx.hex to the object
        return parsedTx;
      } catch {
        return null;
      }
    });
  }

  /**
   * Get blockchain info (passthrough JSON)
   */
  async getBlockchainInfo(): Promise<any> {
    const [info] = [await this.transport.getBlockchainInfo()];
    return info ?? {};
  }

  /**
   * Get network info (passthrough JSON)
   */
  async getNetworkInfo(): Promise<any> {
    const [info] = [await this.transport.getNetworkInfo()];
    return info ?? {};
  }

  /**
   * Estimate fee for target confirmation (passthrough)
   */
  async estimateSmartFee(confTarget: number, estimateMode: string = 'CONSERVATIVE'): Promise<any> {
    return this.transport.estimateSmartFee(confTarget, estimateMode as 'ECONOMICAL' | 'CONSERVATIVE');
  }

  // ===== Normalizers =====

  private normalizeRawTransaction(rawTx: any): UniversalTransaction {
    return {
      txid: rawTx.txid,
      hash: rawTx.hash,
      version: rawTx.version,
      size: rawTx.size,
      vsize: rawTx.vsize,
      weight: rawTx.weight,
      locktime: rawTx.locktime,
      vin: rawTx.vin,
      vout: rawTx.vout,
      hex: undefined,
      blockhash: rawTx.blockhash,
      time: rawTx.time,
      blocktime: rawTx.blocktime,
      fee: rawTx.fee,
      wtxid: rawTx.wtxid,
      depends: rawTx.depends,
      spentby: rawTx.spentby,
      bip125_replaceable: rawTx['bip125-replaceable'],
    } as unknown as UniversalTransaction;
  }

  private normalizeRawBlock(rawBlock: any): UniversalBlock {
    return {
      hash: rawBlock.hash,
      confirmations: rawBlock.confirmations,
      size: rawBlock.size,
      height: rawBlock.height,
      version: rawBlock.version,
      merkleroot: rawBlock.merkleroot,
      time: rawBlock.time,
      mediantime: rawBlock.mediantime,
      nonce: rawBlock.nonce,
      bits: rawBlock.bits,
      difficulty: rawBlock.difficulty,
      chainwork: rawBlock.chainwork,
      nTx: rawBlock.nTx,
      tx: rawBlock.tx?.map((tx: any) => (typeof tx === 'string' ? tx : this.normalizeRawTransaction(tx))),
      previousblockhash: rawBlock.previousblockhash,
      nextblockhash: rawBlock.nextblockhash,
    } as unknown as UniversalBlock;
  }

  private normalizeRawBlockStats(rawStats: any): UniversalBlockStats {
    return {
      avgFee: rawStats.avgfee,
      avgFeeRate: rawStats.avgfeerate,
      avgTxSize: rawStats.avgtxsize,
      blockHash: rawStats.blockhash,
      height: rawStats.height,
      ins: rawStats.ins,
      maxFee: rawStats.maxfee,
      maxFeeRate: rawStats.maxfeerate,
      maxTxSize: rawStats.maxtxsize,
      medianFee: rawStats.medianfee,
      medianFeeRate: rawStats.medianfeerate,
      medianTime: rawStats.mediantime,
      medianTxSize: rawStats.mediantxsize,
      minFee: rawStats.minfee,
      minFeeRate: rawStats.minfeerate,
      minTxSize: rawStats.mintxsize,
      outs: rawStats.outs,
      subsidy: rawStats.subsidy,
      swTotalSize: rawStats.swtotal_size,
      swTotalWeight: rawStats.swtotal_weight,
      swTxs: rawStats.swtxs,
      time: rawStats.time,
      totalOut: rawStats.total_out,
      totalSize: rawStats.total_size,
      totalWeight: rawStats.total_weight,
      totalFees: rawStats.totalfee,
      txs: rawStats.txs,
      utxoIncrease: rawStats.utxo_increase,
      utxoSizeInc: rawStats.utxo_size_inc,
    } as unknown as UniversalBlockStats;
  }

  // ===== P2P SPECIFIC METHODS =====

  /**
   * P2P-specific initialization
   * Wait for header sync if transport supports it
   */
  async initializeP2P(
    options: {
      waitForHeaderSync?: boolean;
      headerSyncTimeout?: number;
    } = {}
  ): Promise<void> {
    if (this.transport.type !== 'p2p') {
      return;
    }

    const p2pTransport = this.transport as any;

    if (options.waitForHeaderSync && typeof p2pTransport.waitForHeaderSync === 'function') {
      await p2pTransport.waitForHeaderSync(options.headerSyncTimeout || 300000);
    }
  }

  /**
   * Get header sync status for P2P transports
   */
  async getP2PStatus(): Promise<{
    isP2P: boolean;
    headerSyncComplete?: boolean;
    syncProgress?: { synced: number; total: number; percentage: number };
  }> {
    if (this.transport.type !== 'p2p') {
      return { isP2P: false };
    }

    const p2pTransport = this.transport as any;

    try {
      const [headerSyncComplete, syncProgress] = await Promise.all([
        p2pTransport.isHeaderSyncComplete?.() || false,
        p2pTransport.getHeaderSyncProgress?.() || { synced: 0, total: 0, percentage: 0 },
      ]);

      return {
        isP2P: true,
        headerSyncComplete,
        syncProgress,
      };
    } catch {
      return { isP2P: true };
    }
  }
}
