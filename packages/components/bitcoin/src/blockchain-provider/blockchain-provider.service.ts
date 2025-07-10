import { Injectable } from '@nestjs/common';
import { AppLogger } from '@easylayer/common/logger';
import { ConnectionManager } from './connection-manager';
import type { NetworkConfig, UniversalBlock, UniversalBlockStats, UniversalTransaction } from './node-providers';
import { BitcoinNormalizer } from './normalizer';
import { Block, Transaction, BlockStats } from './components';

@Injectable()
export class BlockchainProviderService {
  private readonly normalizer: BitcoinNormalizer;

  constructor(
    private readonly log: AppLogger,
    private readonly _connectionManager: ConnectionManager,
    private readonly networkConfig: NetworkConfig
  ) {
    this.normalizer = new BitcoinNormalizer(this.networkConfig);
  }

  get connectionManager() {
    return this._connectionManager;
  }

  get config() {
    return this.networkConfig;
  }

  // ===== BASIC INFO METHODS =====

  /**
   * Gets the current block height
   * Node calls: 1 (getblockcount)
   */
  public async getCurrentBlockHeight(): Promise<number> {
    const provider = await this._connectionManager.getActiveProvider();
    const height = await provider.getBlockHeight();
    return Number(height);
  }

  /**
   * Gets a block hash by height
   * Node calls: 1 (getblockhash)
   * @returns block hash or null if block doesn't exist
   */
  public async getOneBlockHashByHeight(height: string | number): Promise<string | null> {
    try {
      const provider = await this._connectionManager.getActiveProvider();
      const hashes = await provider.getManyBlockHashesByHeights([Number(height)]);
      return hashes[0] || null;
    } catch (error) {
      this.log.error('Failed to get block hash by height', {
        args: { height, error },
        methodName: 'getOneBlockHashByHeight()',
      });
      return null;
    }
  }

  /**
   * Gets multiple block hashes by heights - batch optimized
   * Node calls: 1 (batch getblockhash for all heights)
   */
  public async getManyHashesByHeights(heights: string[] | number[]): Promise<(string | null)[]> {
    const provider = await this._connectionManager.getActiveProvider();
    return await provider.getManyBlockHashesByHeights(heights.map((h) => Number(h)));
  }

  // ===== BLOCK METHODS WITH HEX OPTION =====

  /**
   * Gets a normalized block by height
   * Node calls: 1 (getblockhash + getblock) if useHex=true, 2 (getblockhash + getblock) if useHex=false
   * @param height - block height
   * @param useHex - if true, uses hex parsing for better performance and complete transaction data
   * @param verbosity - verbosity level for object method (ignored if useHex=true)
   * @returns normalized block or null if block doesn't exist
   */
  public async getOneBlockByHeight(
    height: string | number,
    useHex: boolean = false,
    verbosity: number = 1
  ): Promise<Block | null> {
    try {
      const provider = await this._connectionManager.getActiveProvider();

      if (useHex) {
        // Get Universal blocks parsed from hex - GUARANTEES HEIGHT
        const universalBlocks = await provider.getManyBlocksHexByHeights([Number(height)]);
        const universalBlock = universalBlocks[0];

        if (!universalBlock) {
          return null;
        }

        return this.normalizer.normalizeBlock(universalBlock);
      } else {
        // Get structured block data - GUARANTEES HEIGHT
        const rawBlocks = await provider.getManyBlocksByHeights([Number(height)], verbosity);
        const rawBlock = rawBlocks[0];

        if (!rawBlock) {
          return null;
        }

        return this.normalizer.normalizeBlock(rawBlock);
      }
    } catch (error) {
      this.log.error('Failed to get block by height', {
        args: { height, useHex, verbosity, error },
        methodName: 'getOneBlockByHeight()',
      });
      return null;
    }
  }

  /**
   * Gets a normalized block by hash
   * Node calls: 1 (getblock) if useHex=true, 2 (getblock + getblock) if useHex=false and height missing
   * @param hash - block hash
   * @param useHex - if true, uses hex parsing for better performance and complete transaction data
   * @param verbosity - verbosity level for object method (ignored if useHex=true)
   * @returns normalized block or null if block doesn't exist
   */
  public async getOneBlockByHash(hash: string, useHex: boolean = false, verbosity: number = 1): Promise<Block | null> {
    try {
      const provider = await this._connectionManager.getActiveProvider();

      if (useHex) {
        // Get Universal blocks parsed from hex - DOES NOT GUARANTEE HEIGHT
        const universalBlocks = await provider.getManyBlocksHexByHashes([hash]);
        const universalBlock = universalBlocks[0];

        if (!universalBlock) {
          return null;
        }

        // Need to get height separately using public provider method
        const blockInfos = await provider.getManyBlocksByHashes([hash], 1);
        const blockInfo = blockInfos[0];

        if (!blockInfo || blockInfo.height === undefined) {
          return null; // Cannot guarantee height
        }

        // Set height and normalize
        universalBlock.height = blockInfo.height;
        return this.normalizer.normalizeBlock(universalBlock);
      } else {
        // Get structured block data - GUARANTEES HEIGHT
        const rawBlocks = await provider.getManyBlocksByHashes([hash], verbosity);
        const rawBlock = rawBlocks[0];

        if (!rawBlock) {
          return null;
        }

        return this.normalizer.normalizeBlock(rawBlock);
      }
    } catch (error) {
      this.log.error('Failed to get block by hash', {
        args: { hash, useHex, verbosity, error },
        methodName: 'getOneBlockByHash()',
      });
      return null;
    }
  }

  /**
   * Gets multiple normalized blocks by heights
   * Node calls: 1 (batch getblockhash + batch getblock) if useHex=true, 1 (batch getblockhash + batch getblock) if useHex=false
   * @param heights - array of block heights
   * @param useHex - if true, uses hex parsing for better performance and complete transaction data
   * @param verbosity - verbosity level for object method (ignored if useHex=true)
   */
  public async getManyBlocksByHeights(
    heights: string[] | number[],
    useHex: boolean = false,
    verbosity: number = 1
  ): Promise<Block[]> {
    try {
      const provider = await this._connectionManager.getActiveProvider();

      if (useHex) {
        // Get Universal blocks parsed from hex - GUARANTEES HEIGHT
        const universalBlocks = await provider.getManyBlocksHexByHeights(heights.map((item) => Number(item)));

        // Filter out null blocks and normalize
        const validBlocks = universalBlocks.filter((block): block is UniversalBlock => block !== null);
        return this.normalizer.normalizeManyBlocks(validBlocks);
      } else {
        // Get structured blocks - GUARANTEES HEIGHT
        const rawBlocks = await provider.getManyBlocksByHeights(
          heights.map((item) => Number(item)),
          verbosity
        );

        // Filter out null blocks and normalize
        const validBlocks = rawBlocks.filter((block): block is UniversalBlock => block !== null);
        return this.normalizer.normalizeManyBlocks(validBlocks);
      }
    } catch (error) {
      this.log.error('Failed to get many blocks by heights', {
        args: { heightsCount: heights.length, useHex, verbosity, error },
        methodName: 'getManyBlocksByHeights()',
      });
      throw error;
    }
  }

  /**
   * Gets multiple normalized blocks by hashes
   * Node calls: 1 (batch getblock) if useHex=false, 2 (batch getblock + batch getblock) if useHex=true and heights needed
   * @param hashes - array of block hashes
   * @param useHex - if true, uses hex parsing for better performance and complete transaction data
   * @param verbosity - verbosity level for object method (ignored if useHex=true)
   */
  public async getManyBlocksByHashes(
    hashes: string[],
    useHex: boolean = false,
    verbosity: number = 1
  ): Promise<Block[]> {
    try {
      const provider = await this._connectionManager.getActiveProvider();

      if (useHex) {
        // Get Universal blocks parsed from hex - DOES NOT GUARANTEE HEIGHT
        const universalBlocks = await provider.getManyBlocksHexByHashes(hashes);

        // Get heights for valid blocks using public provider method
        const validHashes = hashes.filter((_, index) => universalBlocks[index] !== null);
        if (validHashes.length === 0) {
          return [];
        }

        // Get height info for valid hashes using structured method
        const heightInfos = await provider.getManyBlocksByHashes(validHashes, 1);

        // Combine blocks with heights, filter out invalid
        const completeBlocks: UniversalBlock[] = [];
        let heightIndex = 0;

        universalBlocks.forEach((block, index) => {
          if (block !== null) {
            const heightInfo = heightInfos[heightIndex++];
            if (heightInfo && heightInfo.height !== undefined) {
              block.height = heightInfo.height;
              completeBlocks.push(block);
            }
            // If no height info, skip this block
          }
        });

        return this.normalizer.normalizeManyBlocks(completeBlocks);
      } else {
        // Get structured blocks - GUARANTEES HEIGHT
        const rawBlocks = await provider.getManyBlocksByHashes(hashes, verbosity);

        // Filter out null blocks and normalize
        const validBlocks = rawBlocks.filter((block): block is UniversalBlock => block !== null);
        return this.normalizer.normalizeManyBlocks(validBlocks);
      }
    } catch (error) {
      this.log.error('Failed to get many blocks by hashes', {
        args: { hashesCount: hashes.length, useHex, verbosity, error },
        methodName: 'getManyBlocksByHashes()',
      });
      throw error;
    }
  }

  // ===== BLOCK STATS METHODS =====

  /**
   * Gets block statistics by heights using batch calls
   * Node calls: 2 (batch getblockhash + batch getblockstats, with special genesis handling)
   */
  public async getManyBlocksStatsByHeights(heights: string[] | number[]): Promise<BlockStats[]> {
    try {
      const provider = await this._connectionManager.getActiveProvider();

      // Get raw stats - GUARANTEES HEIGHT
      const rawStats = await provider.getManyBlocksStatsByHeights(heights.map((item) => Number(item)));

      // Filter out null stats and normalize
      const validStats = rawStats.filter((stats): stats is UniversalBlockStats => stats !== null);
      return this.normalizer.normalizeManyBlockStats(validStats);
    } catch (error) {
      this.log.error('Failed to get many blocks stats by heights', {
        args: { heightsCount: heights.length, error },
        methodName: 'getManyBlocksStatsByHeights()',
      });
      throw error;
    }
  }

  /**
   * Gets block statistics by hashes using batch calls
   * Node calls: 1 (batch getblockstats for all hashes)
   */
  public async getManyBlocksStatsByHashes(hashes: string[]): Promise<BlockStats[]> {
    try {
      const provider = await this._connectionManager.getActiveProvider();

      // Get raw stats - GUARANTEES HEIGHT (blockstats includes height)
      const rawStats = await provider.getManyBlocksStatsByHashes(hashes);

      // Filter out null stats and normalize
      const validStats = rawStats.filter((stats): stats is UniversalBlockStats => stats !== null);
      return this.normalizer.normalizeManyBlockStats(validStats);
    } catch (error) {
      this.log.error('Failed to get many blocks stats by hashes', {
        args: { hashesCount: hashes.length, error },
        methodName: 'getManyBlocksStatsByHashes()',
      });
      throw error;
    }
  }

  // ===== TRANSACTION METHODS =====

  /**
   * Gets multiple transactions by txids - batch optimized
   * @param txids - array of transaction IDs
   * @param useHex - if true, uses hex parsing for better performance and complete transaction data
   * @param verbosity - verbosity level for object method (ignored if useHex=true)
   * @returns transactions or empty array if none exist
   */
  public async getTransactionsByTxids(
    txids: string[],
    useHex: boolean = false,
    verbosity: number = 1
  ): Promise<Transaction[]> {
    try {
      const provider = await this._connectionManager.getActiveProvider();

      if (useHex) {
        // Get Universal transactions parsed from hex
        const universalTxs = await provider.getManyTransactionsHexByTxids(txids);

        // Filter out null transactions and normalize
        const validTxs = universalTxs.filter((tx): tx is UniversalTransaction => tx !== null);
        return this.normalizer.normalizeManyTransactions(validTxs);
      } else {
        // Get structured transaction data
        const rawTxs = await provider.getManyTransactionsByTxids(txids, verbosity);

        // Filter out null transactions and normalize
        const validTxs = rawTxs.filter((tx): tx is UniversalTransaction => tx !== null);
        return this.normalizer.normalizeManyTransactions(validTxs);
      }
    } catch (error) {
      this.log.error('Failed to get transactions by txids', {
        args: { txidsCount: txids.length, useHex, verbosity, error },
        methodName: 'getTransactionsByTxids()',
      });
      throw error;
    }
  }

  // ===== NETWORK METHODS =====

  /**
   * Gets blockchain information
   */
  public async getBlockchainInfo(): Promise<any> {
    const provider = await this._connectionManager.getActiveProvider();
    return await provider.getBlockchainInfo();
  }

  /**
   * Gets network information
   */
  public async getNetworkInfo(): Promise<any> {
    const provider = await this._connectionManager.getActiveProvider();
    return await provider.getNetworkInfo();
  }

  /**
   * Gets mempool information
   */
  public async getMempoolInfo(): Promise<any> {
    const provider = await this._connectionManager.getActiveProvider();
    return await provider.getMempoolInfo();
  }

  /**
   * Gets raw mempool
   */
  public async getRawMempool(verbose: boolean = false): Promise<any> {
    const provider = await this._connectionManager.getActiveProvider();
    return await provider.getRawMempool(verbose);
  }

  /**
   * Estimates smart fee
   */
  public async estimateSmartFee(confTarget: number, estimateMode: string = 'CONSERVATIVE'): Promise<any> {
    const provider = await this._connectionManager.getActiveProvider();
    return await provider.estimateSmartFee(confTarget, estimateMode);
  }

  // ===== NETWORK FEATURE UTILITY METHODS =====

  /**
   * Utility method to check if a feature is supported by the current network
   */
  public isFeatureSupported(feature: 'segwit' | 'taproot' | 'rbf' | 'csv' | 'cltv'): boolean {
    switch (feature) {
      case 'segwit':
        return this.networkConfig.hasSegWit;
      case 'taproot':
        return this.networkConfig.hasTaproot;
      case 'rbf':
        return this.networkConfig.hasRBF;
      case 'csv':
        return this.networkConfig.hasCSV;
      case 'cltv':
        return this.networkConfig.hasCLTV;
      default:
        return false;
    }
  }

  // ===== CONVENIENCE METHODS FOR BETTER API =====

  /**
   * High-performance method: Gets a fully parsed block with all transactions
   * This is the fastest way to get complete block with all transactions
   * @returns block or null if doesn't exist
   */
  public async getFullBlockByHeight(height: string | number): Promise<Block | null> {
    return this.getOneBlockByHeight(height, true); // Force hex parsing
  }

  /**
   * High-performance method: Gets a fully parsed block with all transactions
   * @returns block or null if doesn't exist
   */
  public async getFullBlockByHash(hash: string): Promise<Block | null> {
    return this.getOneBlockByHash(hash, true); // Force hex parsing
  }

  /**
   * High-performance method: Gets multiple fully parsed blocks with all transactions
   * This is the most efficient way to get multiple complete blocks
   */
  public async getFullBlocksByHeights(heights: string[] | number[]): Promise<Block[]> {
    return this.getManyBlocksByHeights(heights, true); // Force hex parsing
  }

  /**
   * High-performance method: Gets multiple fully parsed blocks with all transactions
   */
  public async getFullBlocksByHashes(hashes: string[]): Promise<Block[]> {
    return this.getManyBlocksByHashes(hashes, true); // Force hex parsing
  }

  /**
   * Lightweight method: Gets basic block info without transactions
   * @returns block or null if doesn't exist
   */
  public async getBasicBlockByHeight(height: string | number): Promise<Block | null> {
    return this.getOneBlockByHeight(height, false, 1); // Force object parsing with verbosity 1
  }

  /**
   * Lightweight method: Gets basic block info without transactions
   * @returns block or null if doesn't exist
   */
  public async getBasicBlockByHash(hash: string): Promise<Block | null> {
    return this.getOneBlockByHash(hash, false, 1); // Force object parsing with verbosity 1
  }

  /**
   * Lightweight method: Gets multiple basic blocks without transactions
   */
  public async getBasicBlocksByHeights(heights: string[] | number[]): Promise<Block[]> {
    return this.getManyBlocksByHeights(heights, false, 1); // Force object parsing with verbosity 1
  }

  /**
   * Lightweight method: Gets multiple basic blocks without transactions
   */
  public async getBasicBlocksByHashes(hashes: string[]): Promise<Block[]> {
    return this.getManyBlocksByHashes(hashes, false, 1); // Force object parsing with verbosity 1
  }
}
