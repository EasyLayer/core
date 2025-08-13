import type { UniversalBlock, UniversalTransaction, UniversalBlockStats } from '../transports';
import { BaseProvider } from './base.provider';
import { HexTransformer } from './hex-transformer';
import { BitcoinMerkleVerifier } from './merkle-verifier';

/**
 * Network Provider for blockchain operations
 *
 * Responsibilities:
 * - Block retrieval by height/hash with guaranteed height information
 * - Transaction retrieval and parsing
 * - Block statistics retrieval
 * - Real-time block subscriptions
 * - Merkle root verification for security
 *
 * Works with both RPC and P2P transports through unified interface
 * Supports Bitcoin-compatible chains (BTC, BCH, DOGE, LTC) via network config
 * All methods preserve order and handle missing data gracefully with nulls
 */
export class NetworkProvider extends BaseProvider {
  /**
   * Subscribe to new blocks with automatic parsing and verification
   * Node calls: 0 (real-time messages from transport)
   * Memory: No block storage - immediate callback execution
   *
   * @param callback Function to call when new block arrives
   * @returns Subscription object with unsubscribe method
   */
  subscribeToNewBlocks(callback: (block: UniversalBlock) => void): { unsubscribe: () => void } {
    if (typeof this.transport.subscribeToNewBlocks !== 'function') {
      throw new Error('Transport does not support block subscriptions');
    }

    return this.transport.subscribeToNewBlocks((blockData: Buffer) => {
      try {
        const hexData = blockData.toString('hex');
        const parsedBlock = HexTransformer.parseBlockHex(hexData, this.network);
        parsedBlock.hex = hexData;

        // Verify Merkle root for security
        const isValid = BitcoinMerkleVerifier.verifyBlockMerkleRoot(parsedBlock, this.network.hasSegWit);
        if (isValid) {
          callback(parsedBlock as UniversalBlock);
        }
      } catch (error) {
        // Skip invalid blocks silently
      }
    });
  }

  // ===== BASIC BLOCKCHAIN METHODS =====

  /**
   * Get current blockchain height
   * Node calls: 1 (getblockcount for RPC, cached for P2P)
   * Time complexity: O(1)
   */
  async getBlockHeight(): Promise<number> {
    return await this.transport.getBlockHeight();
  }

  /**
   * Get multiple block hashes by heights - PRESERVES ORDER
   * Node calls: 1 (batch getblockhash for all heights)
   * Time complexity: O(k) where k = number of heights
   *
   * @param heights Array of block heights
   * @returns Array of hashes in same order as input, null for missing blocks
   */
  async getManyBlockHashesByHeights(heights: number[]): Promise<(string | null)[]> {
    return await this.transport.getManyBlockHashesByHeights(heights);
  }

  // ===== HEX METHODS =====

  /**
   * Get multiple blocks parsed from hex as Universal objects - ATOMIC METHOD
   * Node calls: 1 (batch getblock with verbosity=0 for all hashes, or P2P GetData)
   * Time complexity: O(k) where k = number of blocks requested
   *
   * @param hashes Array of block hashes
   * @param verifyMerkle Whether to verify Merkle root
   * @returns Array of blocks in same order as input, null for missing blocks
   */
  async getManyBlocksHexByHashes(hashes: string[], verifyMerkle: boolean = false): Promise<(UniversalBlock | null)[]> {
    try {
      // Get block data from transport (works with both RPC and P2P)
      const blockBuffers = await this.transport.requestBlocks(hashes);

      // Process results in same order as input hashes
      return await Promise.all(
        blockBuffers.map(async (buffer, index) => {
          if (!buffer) {
            return null; // Block not found at this hash
          }

          try {
            const hex = buffer.toString('hex');
            const parsedBlock = HexTransformer.parseBlockHex(hex, this.network);
            parsedBlock.hex = hex;

            if (verifyMerkle) {
              const isValid = BitcoinMerkleVerifier.verifyBlockMerkleRoot(parsedBlock, this.network.hasSegWit);
              if (!isValid) {
                throw new Error(
                  `Merkle root verification failed for block ${parsedBlock.hash}. ` +
                    `Expected: ${parsedBlock.merkleroot}, but computed root doesn't match.`
                );
              }
            }

            return parsedBlock as UniversalBlock;
          } catch (error) {
            // Parse error - return null for this position
            return null;
          }
        })
      );
    } catch (error) {
      // Transport error - return array of nulls
      return new Array(hashes.length).fill(null);
    }
  }

  /**
   * Get multiple blocks parsed from hex by heights - COMBINED METHOD
   * Node calls: 2 (batch getblockhash + batch getblock for valid hashes)
   * Time complexity: O(k) where k = number of heights
   *
   * @param heights Array of block heights
   * @param verifyMerkle Whether to verify Merkle root
   * @returns Array of blocks in same order as input heights, null for missing blocks
   */
  async getManyBlocksHexByHeights(
    heights: number[],
    verifyMerkle: boolean = false
  ): Promise<(UniversalBlock | null)[]> {
    // Step 1: Get hashes for all heights - preserves order with nulls
    const hashes = await this.getManyBlockHashesByHeights(heights);

    // Step 2: Get blocks only for valid hashes
    const validHashes = hashes.filter((hash): hash is string => hash !== null);
    if (validHashes.length === 0) {
      return new Array(heights.length).fill(null);
    }

    const hexBlocks = await this.getManyBlocksHexByHashes(validHashes, verifyMerkle);

    // Step 3: Map results back to original order with guaranteed heights
    const results: (UniversalBlock | null)[] = new Array(heights.length).fill(null);
    let blockIndex = 0;

    hashes.forEach((hash, index) => {
      if (hash !== null) {
        const block = hexBlocks[blockIndex++] || null;
        if (block !== null) {
          // Guarantee height since we know it from input
          block.height = heights[index];
          results[index] = block;
        }
      }
    });

    return results;
  }

  // ===== OBJECT METHODS =====

  /**
   * Get multiple blocks as structured objects by hashes
   * Node calls: 1 (batch getblock with specified verbosity)
   * Time complexity: O(k) where k = number of blocks requested
   *
   * @param hashes Array of block hashes
   * @param verbosity Verbosity level (1=with tx hashes, 2=with full tx objects)
   * @param verifyMerkle Whether to verify Merkle root
   * @returns Array of blocks in same order as input, null for missing blocks
   */
  async getManyBlocksByHashes(
    hashes: string[],
    verbosity: number = 1,
    verifyMerkle: boolean = false
  ): Promise<(UniversalBlock | null)[]> {
    const requests = hashes.map((hash) => ({ method: 'getblock', params: [hash, verbosity] }));
    const results = await this.transport.batchCall(requests);

    return await Promise.all(
      results.map(async (rawBlock) => {
        if (rawBlock === null) return null;

        if (verifyMerkle && verbosity >= 1 && rawBlock.tx) {
          const isValid = BitcoinMerkleVerifier.verifyBlockMerkleRoot(rawBlock, this.network.hasSegWit);
          if (!isValid) {
            throw new Error(
              `Merkle root verification failed for block ${rawBlock.hash}. ` +
                `Expected: ${rawBlock.merkleroot}, but computed root doesn't match.`
            );
          }
        }

        return this.normalizeRawBlock(rawBlock);
      })
    );
  }

  /**
   * Get multiple blocks as structured objects by heights
   * Node calls: 2 (batch getblockhash + batch getblock for valid hashes)
   * Time complexity: O(k) where k = number of heights
   *
   * @param heights Array of block heights
   * @param verbosity Verbosity level (1=with tx hashes, 2=with full tx objects)
   * @param verifyMerkle Whether to verify Merkle root
   * @returns Array of blocks in same order as input heights, null for missing blocks
   */
  async getManyBlocksByHeights(
    heights: number[],
    verbosity: number = 1,
    verifyMerkle: boolean = false
  ): Promise<(UniversalBlock | null)[]> {
    const blocksHashes = await this.getManyBlockHashesByHeights(heights);
    const validHashes = blocksHashes.filter((hash): hash is string => hash !== null);

    if (validHashes.length === 0) {
      return new Array(heights.length).fill(null);
    }

    const blocks = await this.getManyBlocksByHashes(validHashes, verbosity, verifyMerkle);

    // Map back to original order with guaranteed heights
    const results: (UniversalBlock | null)[] = new Array(heights.length).fill(null);
    let blockIndex = 0;

    blocksHashes.forEach((hash, index) => {
      if (hash !== null) {
        const block = blocks[blockIndex++] || null;
        if (block !== null) {
          // Guarantee height since we know it from input
          block.height = heights[index];
          results[index] = block;
        }
      }
    });

    return results;
  }

  // ===== BLOCK STATS METHODS =====

  /**
   * Get block statistics by hashes
   * Node calls: 1 (batch getblockstats for all hashes)
   * Time complexity: O(k) where k = number of hashes
   *
   * @param hashes Array of block hashes
   * @returns Array of stats in same order as input, null for missing blocks
   */
  async getManyBlocksStatsByHashes(hashes: string[]): Promise<(UniversalBlockStats | null)[]> {
    const requests = hashes.map((hash) => ({ method: 'getblockstats', params: [hash] }));
    const results = await this.transport.batchCall(requests);

    return results.map((rawStats) => {
      if (rawStats === null) return null;
      return this.normalizeRawBlockStats(rawStats);
    });
  }

  /**
   * Get block statistics by heights with special genesis handling
   * Node calls: 2 (batch getblockhash + batch getblockstats, with genesis handling)
   * Time complexity: O(k) where k = number of heights
   *
   * @param heights Array of block heights
   * @returns Array of stats in same order as input heights, null for missing blocks
   */
  async getManyBlocksStatsByHeights(heights: number[]): Promise<(UniversalBlockStats | null)[]> {
    const genesisHeight = 0;
    const hasGenesis = heights.includes(genesisHeight);

    if (hasGenesis) {
      // Handle genesis block separately (getblockstats doesn't work for genesis)
      const genesisResults = await this.transport.batchCall([{ method: 'getblockhash', params: [genesisHeight] }]);
      const genesisHash = genesisResults[0];

      const filteredHeights = heights.filter((height) => height !== genesisHeight);
      const blocksHashes = await this.getManyBlockHashesByHeights(filteredHeights);

      const validHashes = blocksHashes.filter((hash): hash is string => hash !== null);
      const blocks = validHashes.length > 0 ? await this.getManyBlocksStatsByHashes(validHashes) : [];

      // Create mock genesis stats
      const genesisMock: UniversalBlockStats = {
        blockhash: genesisHash,
        total_size: 0,
        height: genesisHeight,
      };

      // Map results back to original order
      const results: (UniversalBlockStats | null)[] = new Array(heights.length).fill(null);
      let blockIndex = 0;

      heights.forEach((height, index) => {
        if (height === genesisHeight) {
          results[index] = genesisMock;
        } else {
          const hashIndex = filteredHeights.indexOf(height);
          if (hashIndex !== -1 && blocksHashes[hashIndex] !== null) {
            results[index] = blocks[blockIndex++] || null;
          }
        }
      });

      return results;
    } else {
      // No genesis, use regular flow
      const blocksHashes = await this.getManyBlockHashesByHeights(heights);
      const validHashes = blocksHashes.filter((hash): hash is string => hash !== null);

      if (validHashes.length === 0) {
        return new Array(heights.length).fill(null);
      }

      const blocks = await this.getManyBlocksStatsByHashes(validHashes);

      const results: (UniversalBlockStats | null)[] = new Array(heights.length).fill(null);
      let blockIndex = 0;

      blocksHashes.forEach((hash, index) => {
        if (hash !== null) {
          results[index] = blocks[blockIndex++] || null;
        }
      });

      return results;
    }
  }

  // ===== TRANSACTION METHODS =====

  /**
   * Get multiple transactions by txids as structured objects
   * Node calls: 1 (batch getrawtransaction for all txids)
   * Time complexity: O(k) where k = number of transactions
   *
   * @param txids Array of transaction IDs
   * @param verbosity Verbosity level for transaction data
   * @returns Array of transactions in same order as input, null for missing transactions
   */
  async getManyTransactionsByTxids(txids: string[], verbosity: number = 1): Promise<(UniversalTransaction | null)[]> {
    const requests = txids.map((txid) => ({
      method: 'getrawtransaction',
      params: [txid, verbosity],
    }));

    const results = await this.transport.batchCall(requests);

    return results.map((rawTx) => {
      if (rawTx === null) return null;
      return this.normalizeRawTransaction(rawTx);
    });
  }

  /**
   * Get multiple transactions by txids parsed from hex
   * Node calls: 1 (batch getrawtransaction with verbosity=0 for all txids)
   * Time complexity: O(k) where k = number of transactions
   *
   * @param txids Array of transaction IDs
   * @returns Array of transactions in same order as input, null for missing transactions
   */
  async getManyTransactionsHexByTxids(txids: string[]): Promise<(UniversalTransaction | null)[]> {
    const hexRequests = txids.map((txid) => ({
      method: 'getrawtransaction',
      params: [txid, false], // false = hex format
    }));

    const hexResults = await this.transport.batchCall(hexRequests);

    return hexResults.map((hex) => {
      if (hex === null) return null;

      try {
        const parsedTx = HexTransformer.parseTransactionHex(hex, this.network);
        parsedTx.hex = hex;
        return parsedTx;
      } catch (error) {
        return null;
      }
    });
  }

  // ===== NETWORK METHODS =====

  /**
   * Get blockchain information
   * Node calls: 1 (getblockchaininfo)
   */
  async getBlockchainInfo(): Promise<any> {
    const results = await this.transport.batchCall([{ method: 'getblockchaininfo', params: [] }]);
    return results[0];
  }

  /**
   * Get network information
   * Node calls: 1 (getnetworkinfo)
   */
  async getNetworkInfo(): Promise<any> {
    const results = await this.transport.batchCall([{ method: 'getnetworkinfo', params: [] }]);
    return results[0];
  }

  /**
   * Estimate smart fee
   * Node calls: 1 (estimatesmartfee)
   */
  async estimateSmartFee(confTarget: number, estimateMode: string = 'CONSERVATIVE'): Promise<any> {
    const results = await this.transport.batchCall([
      { method: 'estimatesmartfee', params: [confTarget, estimateMode] },
    ]);
    return results[0];
  }

  // ===== P2P SPECIFIC METHODS =====

  /**
   * P2P-specific initialization - NEW METHOD
   * Wait for header sync if transport supports it
   */
  async initializeP2P(
    options: {
      waitForHeaderSync?: boolean;
      headerSyncTimeout?: number;
    } = {}
  ): Promise<void> {
    if (this.transport.type !== 'P2P') {
      return; // Only for P2P transports
    }

    const p2pTransport = this.transport as any; // Cast to access P2P methods

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
    if (this.transport.type !== 'P2P') {
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

  // ===== NORMALIZATION METHODS =====

  /**
   * Normalize raw block data to UniversalBlock format
   */
  private normalizeRawBlock(rawBlock: any): UniversalBlock {
    return {
      hash: rawBlock.hash,
      height: rawBlock.height,
      strippedsize: rawBlock.strippedsize,
      size: rawBlock.size,
      weight: rawBlock.weight,
      version: rawBlock.version,
      versionHex: rawBlock.versionHex,
      merkleroot: rawBlock.merkleroot,
      time: rawBlock.time,
      mediantime: rawBlock.mediantime,
      nonce: rawBlock.nonce,
      bits: rawBlock.bits,
      difficulty: rawBlock.difficulty,
      chainwork: rawBlock.chainwork,
      previousblockhash: rawBlock.previousblockhash,
      nextblockhash: rawBlock.nextblockhash,
      tx: rawBlock.tx?.map((tx: any) => (typeof tx === 'string' ? tx : this.normalizeRawTransaction(tx))),
      nTx: rawBlock.nTx,
      fee: rawBlock.fee,
      subsidy: rawBlock.subsidy,
      miner: rawBlock.miner,
      pool: rawBlock.pool,
    };
  }

  /**
   * Normalize raw transaction data to UniversalTransaction format
   */
  private normalizeRawTransaction(rawTx: any): UniversalTransaction {
    return {
      txid: rawTx.txid,
      hash: rawTx.hash,
      version: rawTx.version,
      size: rawTx.size,
      vsize: rawTx.vsize,
      weight: rawTx.weight,
      locktime: rawTx.locktime,
      vin:
        rawTx.vin?.map((vin: any) => ({
          txid: vin.txid,
          vout: vin.vout,
          scriptSig: vin.scriptSig,
          sequence: vin.sequence,
          coinbase: vin.coinbase,
          txinwitness: vin.txinwitness,
        })) || [],
      vout:
        rawTx.vout?.map((vout: any) => ({
          value: vout.value,
          n: vout.n,
          scriptPubKey: vout.scriptPubKey,
        })) || [],
      blockhash: rawTx.blockhash,
      time: rawTx.time,
      blocktime: rawTx.blocktime,
      fee: rawTx.fee,
      wtxid: rawTx.wtxid,
      depends: rawTx.depends,
      spentby: rawTx.spentby,
      bip125_replaceable: rawTx['bip125-replaceable'],
    };
  }

  /**
   * Normalize raw block stats data to UniversalBlockStats format
   */
  private normalizeRawBlockStats(rawStats: any): UniversalBlockStats {
    return {
      blockhash: rawStats.blockhash,
      height: rawStats.height,
      total_size: rawStats.total_size,
      total_weight: rawStats.total_weight,
      total_fee: rawStats.total_fee,
      fee_rate_percentiles: rawStats.fee_rate_percentiles,
      subsidy: rawStats.subsidy,
      total_out: rawStats.total_out,
      utxo_increase: rawStats.utxo_increase,
      utxo_size_inc: rawStats.utxo_size_inc,
      ins: rawStats.ins,
      outs: rawStats.outs,
      txs: rawStats.txs,
      minfee: rawStats.minfee,
      maxfee: rawStats.maxfee,
      medianfee: rawStats.medianfee,
      avgfee: rawStats.avgfee,
      minfeerate: rawStats.minfeerate,
      maxfeerate: rawStats.maxfeerate,
      medianfeerate: rawStats.medianfeerate,
      avgfeerate: rawStats.avgfeerate,
      mintxsize: rawStats.mintxsize,
      maxtxsize: rawStats.maxtxsize,
      mediantxsize: rawStats.mediantxsize,
      avgtxsize: rawStats.avgtxsize,
      total_stripped_size: rawStats.total_stripped_size,
      witness_txs: rawStats.witness_txs,
    };
  }
}
