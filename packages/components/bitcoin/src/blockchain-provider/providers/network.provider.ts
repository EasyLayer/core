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

  // ===== HEX METHODS =====

  /**
   * Get multiple blocks parsed from hex as Universal objects
   * Node calls: 1 (batch getblock with verbosity=0 for all hashes, or P2P GetData)
   * Time complexity: O(k) where k = number of blocks requested
   *
   * @param hashes Array of block hashes
   * @param verifyMerkle Whether to verify Merkle root
   * @returns Array of blocks in same order as input, null for missing blocks
   */
  async getManyBlocksHexByHashes(hashes: string[], verifyMerkle: boolean = false): Promise<(UniversalBlock | null)[]> {
    try {
      const hexBlockBuffers = await this.transport.requestHexBlocks(hashes);

      return await Promise.all(
        hexBlockBuffers.map(async (buffer, index) => {
          if (!buffer) {
            return null;
          }

          try {
            const hex = buffer.toString('hex');
            const parsedBlock = HexTransformer.parseBlockHex(hex, this.network);
            parsedBlock.hex = hex;

            if (verifyMerkle) {
              const isValid = BitcoinMerkleVerifier.verifyBlockMerkleRoot(parsedBlock, this.network.hasSegWit);
              if (!isValid) {
                return null;
              }
            }

            return parsedBlock as UniversalBlock;
          } catch (error) {
            return null;
          }
        })
      );
    } catch (error) {
      return new Array(hashes.length).fill(null);
    }
  }

  /**
   * Get multiple blocks parsed from hex by heights
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
    const hashes = await this.getManyBlockHashesByHeights(heights);
    const validHashes = hashes.filter((hash): hash is string => hash !== null);

    if (validHashes.length === 0) {
      return new Array(heights.length).fill(null);
    }

    const hexBlocks = await this.getManyBlocksHexByHashes(validHashes, verifyMerkle);

    // Create map for hash -> block lookup
    const hashToBlock = new Map<string, UniversalBlock | null>();
    validHashes.forEach((hash, index) => {
      hashToBlock.set(hash, hexBlocks[index] || null);
    });

    // Restore order according to original heights
    return hashes.map((hash, index) => {
      if (hash === null) {
        return null;
      }

      const block = hashToBlock.get(hash) || null;
      if (block !== null) {
        block.height = heights[index];
      }

      return block;
    });
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

        try {
          if (verifyMerkle && verbosity >= 1 && rawBlock.tx) {
            const isValid = BitcoinMerkleVerifier.verifyBlockMerkleRoot(rawBlock, this.network.hasSegWit);
            if (!isValid) {
              return null;
            }
          }

          return this.normalizeRawBlock(rawBlock);
        } catch (error) {
          return null;
        }
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

    // Create map for hash -> block lookup
    const hashToBlock = new Map<string, UniversalBlock | null>();
    validHashes.forEach((hash, index) => {
      hashToBlock.set(hash, blocks[index] || null);
    });

    // Restore order according to original heights
    return blocksHashes.map((hash, index) => {
      if (hash === null) {
        return null;
      }

      const block = hashToBlock.get(hash) || null;
      if (block !== null) {
        block.height = heights[index];
      }

      return block;
    });
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

      try {
        return this.normalizeRawBlockStats(rawStats);
      } catch (error) {
        return null;
      }
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
      try {
        // Get genesis hash
        const genesisResults = await this.transport.batchCall([{ method: 'getblockhash', params: [genesisHeight] }]);
        const genesisHash = genesisResults[0];

        // Get stats for non-genesis blocks
        const filteredHeights = heights.filter((height) => height !== genesisHeight);
        let filteredStats: (UniversalBlockStats | null)[] = [];

        if (filteredHeights.length > 0) {
          const blocksHashes = await this.getManyBlockHashesByHeights(filteredHeights);
          const validHashes = blocksHashes.filter((hash): hash is string => hash !== null);

          if (validHashes.length > 0) {
            const statsResults = await this.getManyBlocksStatsByHashes(validHashes);

            // Create map for hash -> stats lookup
            const hashToStats = new Map<string, UniversalBlockStats | null>();
            validHashes.forEach((hash, index) => {
              hashToStats.set(hash, statsResults[index] || null);
            });

            // Map stats back to filtered heights order
            filteredStats = blocksHashes.map((hash) => (hash ? hashToStats.get(hash) || null : null));
          }
        }

        // Create genesis mock with available data (getblockstats doesn't support genesis)
        const genesisMock: UniversalBlockStats | null = genesisHash
          ? {
              blockhash: genesisHash,
              height: genesisHeight,
              total_size: 285, // Known Bitcoin genesis block size
              total_weight: 1140, // Known weight (285 * 4 for non-segwit)
              total_fee: 0, // No fees in genesis
              // fee_rate_percentiles: [0, 0, 0, 0, 0], // No fees
              // subsidy: 5000000000,          // 50 BTC in satoshis
              // total_out: 5000000000,        // Same as subsidy
              // utxo_increase: 1,             // One new UTXO created
              // utxo_size_inc: 43,            // Estimated UTXO size increase
              // ins: 0,                       // No real inputs (coinbase)
              // outs: 1,                      // One output
              // txs: 1,                       // One transaction
              // minfee: 0,                    // No fees
              // maxfee: 0,
              // medianfee: 0,
              // avgfee: 0,
              // minfeerate: 0,                // No fee rates
              // maxfeerate: 0,
              // medianfeerate: 0,
              // avgfeerate: 0,
              // mintxsize: 204,               // Genesis transaction size
              // maxtxsize: 204,
              // mediantxsize: 204,
              // avgtxsize: 204,
              // total_stripped_size: 285,     // Same as total_size for non-segwit
              // witness_txs: 0,               // No witness transactions in genesis
            }
          : null;

        // Combine results in original order
        const results: (UniversalBlockStats | null)[] = [];
        let filteredIndex = 0;

        heights.forEach((height) => {
          if (height === genesisHeight) {
            results.push(genesisMock);
          } else {
            results.push(filteredStats[filteredIndex] || null);
            filteredIndex++;
          }
        });

        return results;
      } catch (error) {
        return new Array(heights.length).fill(null);
      }
    } else {
      // No genesis, use regular flow
      const blocksHashes = await this.getManyBlockHashesByHeights(heights);
      const validHashes = blocksHashes.filter((hash): hash is string => hash !== null);

      if (validHashes.length === 0) {
        return new Array(heights.length).fill(null);
      }

      const blocks = await this.getManyBlocksStatsByHashes(validHashes);

      // Create map for hash -> stats lookup
      const hashToStats = new Map<string, UniversalBlockStats | null>();
      validHashes.forEach((hash, index) => {
        hashToStats.set(hash, blocks[index] || null);
      });

      // Restore order according to original heights
      return blocksHashes.map((hash) => (hash ? hashToStats.get(hash) || null : null));
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

      try {
        return this.normalizeRawTransaction(rawTx);
      } catch (error) {
        return null;
      }
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
    const info = results[0];

    if (info === null) {
      throw new Error('Failed to get blockchain info: null response from transport');
    }

    return info;
  }

  /**
   * Get network information
   * Node calls: 1 (getnetworkinfo)
   */
  async getNetworkInfo(): Promise<any> {
    const results = await this.transport.batchCall([{ method: 'getnetworkinfo', params: [] }]);
    const info = results[0];

    if (info === null) {
      throw new Error('Failed to get network info: null response from transport');
    }

    return info;
  }

  /**
   * Estimate smart fee
   * Node calls: 1 (estimatesmartfee)
   */
  async estimateSmartFee(confTarget: number, estimateMode: string = 'CONSERVATIVE'): Promise<any> {
    const results = await this.transport.batchCall([
      { method: 'estimatesmartfee', params: [confTarget, estimateMode] },
    ]);

    const feeData = results[0];

    if (feeData === null) {
      throw new Error('Failed to estimate smart fee: null response from transport');
    }

    return feeData;
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
