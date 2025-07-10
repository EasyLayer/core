import * as http from 'node:http';
import * as https from 'node:https';
import type { BaseNodeProviderOptions } from './base-node-provider';
import { BaseNodeProvider } from './base-node-provider';
import type { NetworkConfig, UniversalBlock, UniversalTransaction, UniversalBlockStats } from './interfaces';
import { NodeProviderTypes } from './interfaces';
import { BitcoinErrorHandler } from './errors';
import { HexTransformer } from './hex-transformer';
import { RateLimiter } from './rate-limiter';

export interface SelfNodeProviderOptions extends BaseNodeProviderOptions {
  baseUrl: string;
  network: NetworkConfig;
  /** Response timeout in milliseconds (default: 5000) */
  responseTimeout?: number;
}

export const createSelfNodeProvider = (options: SelfNodeProviderOptions): SelfNodeProvider => {
  return new SelfNodeProvider(options);
};

export class SelfNodeProvider extends BaseNodeProvider<SelfNodeProviderOptions> {
  readonly type: NodeProviderTypes = NodeProviderTypes.SELFNODE;
  private baseUrl: string;
  private username?: string;
  private password?: string;
  private requestId = 1;
  private responseTimeout: number;
  private network: NetworkConfig;
  private rateLimiter: RateLimiter;

  constructor(options: SelfNodeProviderOptions) {
    super(options);

    // Parse the baseUrl to extract username and password
    const url = new URL(options.baseUrl);
    this.username = url.username || undefined;
    this.password = url.password || undefined;

    this.responseTimeout = options.responseTimeout ?? 5000;

    // Remove username and password from baseUrl
    url.username = '';
    url.password = '';
    this.baseUrl = url.toString();

    this.network = options.network;
    this.rateLimiter = new RateLimiter(options.rateLimits);

    // Determine whether to use HTTP or HTTPS, and create the appropriate agent
    const isHttps = this.baseUrl.startsWith('https://');
    this._httpClient = isHttps
      ? new https.Agent({
          keepAlive: true,
          keepAliveMsecs: 1000,
          maxSockets: 5,
          maxFreeSockets: 2,
          timeout: this.responseTimeout,
        })
      : new http.Agent({
          keepAlive: true,
          keepAliveMsecs: 1000,
          maxSockets: 5,
          maxFreeSockets: 2,
          timeout: this.responseTimeout,
        });
  }

  get connectionOptions() {
    return {
      type: this.type,
      uniqName: this.uniqName,
      baseUrl: this.baseUrl,
      rateLimits: this.rateLimits,
      network: this.network,
    };
  }

  public async connect() {
    const health = await this.healthcheck();
    if (!health) {
      throw new Error('Cannot connect to the node');
    }
  }

  public async healthcheck(): Promise<boolean> {
    try {
      await this.rateLimiter.execute([{ method: 'getblockchaininfo', params: [] }], (calls) =>
        this._batchRpcCall(calls)
      );
      return true;
    } catch (error) {
      return false;
    }
  }

  public async disconnect() {
    // 1. Stop rate limiter first
    await this.rateLimiter.stop();

    // 2. HTTPS fix - force close connections
    if (this._httpClient && this.baseUrl.startsWith('https://')) {
      // Force destroy all HTTPS sockets immediately
      const agent = this._httpClient as any;

      // Destroy active sockets
      if (agent.sockets) {
        Object.values(agent.sockets).forEach((sockets: any) => {
          if (Array.isArray(sockets)) {
            sockets.forEach((socket: any) => socket?.destroy?.());
          }
        });
      }

      // Destroy free sockets
      if (agent.freeSockets) {
        Object.values(agent.freeSockets).forEach((sockets: any) => {
          if (Array.isArray(sockets)) {
            sockets.forEach((socket: any) => socket?.destroy?.());
          }
        });
      }
    }

    // 3. Destroy HTTP agent
    if (this._httpClient) {
      this._httpClient.destroy();
      this._httpClient = null;
    }
  }

  /**
   * Batch RPC call method for multiple requests
   * Uses HTTP agent timeout instead of manual setTimeout to prevent resource leaks
   */
  private async _batchRpcCall(calls: Array<{ method: string; params: any[] }>): Promise<any[]> {
    try {
      const headers = new Headers();
      headers.set('Content-Type', 'application/json');

      if (this.username && this.password) {
        const auth = Buffer.from(`${this.username}:${this.password}`).toString('base64');
        headers.set('Authorization', `Basic ${auth}`);
      }

      const payload = calls.map((call) => ({
        jsonrpc: '2.0',
        method: call.method,
        params: call.params,
        id: this.requestId++,
      }));

      const requestOptions: RequestInit = {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        ...(this._httpClient && { agent: this._httpClient }),
      };

      const response = await fetch(this.baseUrl, requestOptions);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP error! Status: ${response.status}, ${errorText}`);
      }

      const results = (await response.json()) as Array<{ result?: any; error?: any }>;

      if (!Array.isArray(results)) {
        throw new Error('Invalid response structure: response data is not an array');
      }

      return results.map((result) => {
        if (result.error) {
          // IMPORTANT: in error case return null - preserves order
          return null;
        }
        return result.result;
      });
    } catch (error: any) {
      if (error.code === 'ETIMEDOUT' || error.code === 'ECONNRESET') {
        throw new Error(`Request timed out after ${this.responseTimeout} ms`);
      }
      if (error.code === 'ECONNREFUSED') {
        throw new Error(`Connection refused to ${this.baseUrl}`);
      }
      if (error.code === 'ENOTFOUND') {
        throw new Error(`Host not found: ${this.baseUrl}`);
      }
      // Re-throw original error with more context
      throw new Error(`Network request failed: ${error.message}`);
    }
  }

  // ===== BASIC BLOCKCHAIN METHODS =====

  public async getBlockHeight(): Promise<number> {
    try {
      const results = await this.rateLimiter.execute([{ method: 'getblockcount', params: [] }], (calls) =>
        this._batchRpcCall(calls)
      );
      return results[0];
    } catch (error) {
      BitcoinErrorHandler.handleError(error, 'getBlockHeight', { provider: this.type, baseUrl: this.baseUrl });
    }
  }

  public async getManyBlockHashesByHeights(heights: number[]): Promise<string[]> {
    try {
      const requests = heights.map((height) => ({ method: 'getblockhash', params: [height] }));

      return await this.rateLimiter.execute(requests, (calls) => this._batchRpcCall(calls));
      // _batchRpcCall already returns null for errors, preserving order
    } catch (error) {
      BitcoinErrorHandler.handleError(error, 'getManyHashesByHeights', {
        provider: this.type,
        totalHeights: heights.length,
      });
    }
  }

  // ===== HEX METHODS (parse hex to Universal objects) =====

  /**
   * Get multiple blocks parsed from hex as Universal objects - ATOMIC METHOD
   * Returns blocks parsed from hex only, without height (height must be set separately)
   */
  public async getManyBlocksHexByHashes(hashes: string[]): Promise<(UniversalBlock | null)[]> {
    try {
      // Get hex data for all blocks
      const hexRequests = hashes.map((hash) => ({ method: 'getblock', params: [hash, 0] }));
      const hexResults = await this.rateLimiter.execute(hexRequests, (calls) => this._batchRpcCall(calls));

      // Parse hex to Universal blocks, preserving order
      return hexResults.map((hex) => {
        if (hex === null) {
          return null;
        }

        // Parse hex and normalize through HexTransformer
        const parsedBlock = HexTransformer.parseBlockHex(hex, this.network);
        parsedBlock.hex = hex;
        return parsedBlock;
      });
    } catch (error) {
      BitcoinErrorHandler.handleError(error, 'getManyBlocksHexByHashes', {
        provider: this.type,
        totalHashes: hashes.length,
      });
    }
  }

  /**
   * Get multiple blocks parsed from hex by heights as Universal objects - COMBINED METHOD
   * Guarantees height for all returned blocks since we know the heights from input
   */
  public async getManyBlocksHexByHeights(heights: number[]): Promise<(UniversalBlock | null)[]> {
    try {
      // Get hashes using our internal method - preserves order with nulls
      const hashes = await this.getManyBlockHashesByHeights(heights);

      // Get hex blocks for valid hashes only
      const validHashes = hashes.filter((hash): hash is string => hash !== null);
      if (validHashes.length === 0) {
        return new Array(heights.length).fill(null);
      }

      const hexBlocks = await this.getManyBlocksHexByHashes(validHashes);

      // Map results back to original order with guaranteed heights
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
    } catch (error) {
      BitcoinErrorHandler.handleError(error, 'getManyBlocksHexByHeights', {
        provider: this.type,
        totalHeights: heights.length,
      });
    }
  }

  // ===== OBJECT METHODS (return Universal*) =====

  /**
   * Get multiple blocks as structured objects - ATOMIC METHOD
   */
  public async getManyBlocksByHashes(hashes: string[], verbosity: number = 1): Promise<(UniversalBlock | null)[]> {
    try {
      const requests = hashes.map((hash) => ({ method: 'getblock', params: [hash, verbosity] }));
      const results = await this.rateLimiter.execute(requests, (calls) => this._batchRpcCall(calls));

      // Preserve order, normalize only non-null blocks
      return results.map((rawBlock) => {
        if (rawBlock === null) {
          return null;
        }
        return this.normalizeRawBlock(rawBlock);
      });
    } catch (error) {
      BitcoinErrorHandler.handleError(error, 'getManyBlocksByHashes', {
        provider: this.type,
        totalHashes: hashes.length,
        verbosity,
      });
    }
  }

  /**
   * Get multiple blocks by heights as structured objects - COMBINED METHOD
   */
  public async getManyBlocksByHeights(heights: number[], verbosity: number = 1): Promise<(UniversalBlock | null)[]> {
    try {
      // Get hashes first - preserves order, null for missing
      const blocksHashes = await this.getManyBlockHashesByHeights(heights);

      // Only request blocks for valid hashes
      const validHashes = blocksHashes.filter((hash): hash is string => hash !== null);
      if (validHashes.length === 0) {
        return new Array(heights.length).fill(null);
      }

      const blocks = await this.getManyBlocksByHashes(validHashes, verbosity);

      // Map back to original order
      const results: (UniversalBlock | null)[] = new Array(heights.length).fill(null);
      let blockIndex = 0;

      blocksHashes.forEach((hash, index) => {
        if (hash !== null) {
          results[index] = blocks[blockIndex++] || null;
        }
      });

      return results;
    } catch (error) {
      BitcoinErrorHandler.handleError(error, 'getManyBlocksByHeights', {
        provider: this.type,
        totalHeights: heights.length,
        verbosity,
      });
    }
  }

  // ===== BLOCK STATS METHODS =====

  public async getManyBlocksStatsByHashes(hashes: string[]): Promise<(UniversalBlockStats | null)[]> {
    try {
      const requests = hashes.map((hash) => ({ method: 'getblockstats', params: [hash] }));
      const results = await this.rateLimiter.execute(requests, (calls) => this._batchRpcCall(calls));

      // Preserve order, normalize only non-null stats
      return results.map((rawStats) => {
        if (rawStats === null) {
          return null;
        }
        return this.normalizeRawBlockStats(rawStats);
      });
    } catch (error) {
      BitcoinErrorHandler.handleError(error, 'getManyBlocksStatsByHashes', {
        provider: this.type,
        totalHashes: hashes.length,
      });
    }
  }

  public async getManyBlocksStatsByHeights(heights: number[]): Promise<(UniversalBlockStats | null)[]> {
    const genesisHeight = 0;
    const hasGenesis = heights.includes(genesisHeight);

    try {
      if (hasGenesis) {
        // Handle genesis block separately since getblockstats doesn't work for it
        const genesisResults = await this.rateLimiter.execute(
          [{ method: 'getblockhash', params: [genesisHeight] }],
          (calls) => this._batchRpcCall(calls)
        );
        const genesisHash = genesisResults[0];

        // Get stats for non-genesis blocks
        const filteredHeights = heights.filter((height) => height !== genesisHeight);
        const blocksHashes = await this.getManyBlockHashesByHeights(filteredHeights);

        // Only get stats for valid hashes
        const validHashes = blocksHashes.filter((hash): hash is string => hash !== null);
        const blocks = validHashes.length > 0 ? await this.getManyBlocksStatsByHashes(validHashes) : [];

        // Create genesis mock
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

        // Only get stats for valid hashes
        const validHashes = blocksHashes.filter((hash): hash is string => hash !== null);
        if (validHashes.length === 0) {
          return new Array(heights.length).fill(null);
        }

        const blocks = await this.getManyBlocksStatsByHashes(validHashes);

        // Map back to original order
        const results: (UniversalBlockStats | null)[] = new Array(heights.length).fill(null);
        let blockIndex = 0;

        blocksHashes.forEach((hash, index) => {
          if (hash !== null) {
            results[index] = blocks[blockIndex++] || null;
          }
        });

        return results;
      }
    } catch (error) {
      BitcoinErrorHandler.handleError(error, 'getManyBlocksStatsByHeights', {
        provider: this.type,
        totalHeights: heights.length,
        hasGenesis,
      });
    }
  }

  /**
   * Get multiple transactions as structured objects - ATOMIC METHOD
   */
  public async getManyTransactionsByTxids(
    txids: string[],
    verbosity: number = 1
  ): Promise<(UniversalTransaction | null)[]> {
    try {
      const requests = txids.map((txid) => ({
        method: 'getrawtransaction',
        params: [txid, verbosity], // verbosity 1 = JSON object, 2 = with prevout info
      }));

      const results = await this.rateLimiter.execute(requests, (calls) => this._batchRpcCall(calls));

      // Preserve order, normalize only non-null transactions
      return results.map((rawTx) => {
        if (rawTx === null) {
          return null;
        }
        return this.normalizeRawTransaction(rawTx);
      });
    } catch (error) {
      BitcoinErrorHandler.handleError(error, 'getManyTransactionsByTxids', {
        provider: this.type,
        totalTxids: txids.length,
        verbosity,
      });
    }
  }

  /**
   * Get multiple transactions parsed from hex as Universal objects - ATOMIC METHOD
   * Returns transactions parsed from hex only
   */
  public async getManyTransactionsHexByTxids(txids: string[]): Promise<(UniversalTransaction | null)[]> {
    try {
      // Get hex data for all transactions
      const hexRequests = txids.map((txid) => ({
        method: 'getrawtransaction',
        params: [txid, false], // false = hex format
      }));

      const hexResults = await this.rateLimiter.execute(hexRequests, (calls) => this._batchRpcCall(calls));

      // Parse hex to Universal transactions, preserving order
      return hexResults.map((hex) => {
        if (hex === null) {
          return null;
        }

        try {
          // Parse hex and normalize through HexTransformer
          const parsedTx = HexTransformer.parseTransactionHex(hex, this.network);
          parsedTx.hex = hex;
          return parsedTx;
        } catch (error) {
          return null;
        }
      });
    } catch (error) {
      BitcoinErrorHandler.handleError(error, 'getManyTransactionsHexByTxids', {
        provider: this.type,
        totalTxids: txids.length,
      });
    }
  }

  // ===== NETWORK METHODS =====

  public async getBlockchainInfo(): Promise<any> {
    try {
      const results = await this.rateLimiter.execute([{ method: 'getblockchaininfo', params: [] }], (calls) =>
        this._batchRpcCall(calls)
      );
      return results[0];
    } catch (error) {
      BitcoinErrorHandler.handleError(error, 'getBlockchainInfo', { provider: this.type, baseUrl: this.baseUrl });
    }
  }

  public async getNetworkInfo(): Promise<any> {
    try {
      const results = await this.rateLimiter.execute([{ method: 'getnetworkinfo', params: [] }], (calls) =>
        this._batchRpcCall(calls)
      );
      return results[0];
    } catch (error) {
      BitcoinErrorHandler.handleError(error, 'getNetworkInfo', { provider: this.type, baseUrl: this.baseUrl });
    }
  }

  public async getMempoolInfo(): Promise<any> {
    try {
      const results = await this.rateLimiter.execute([{ method: 'getmempoolinfo', params: [] }], (calls) =>
        this._batchRpcCall(calls)
      );
      return results[0];
    } catch (error) {
      BitcoinErrorHandler.handleError(error, 'getMempoolInfo', { provider: this.type, baseUrl: this.baseUrl });
    }
  }

  public async getRawMempool(verbose: boolean = false): Promise<any> {
    try {
      const results = await this.rateLimiter.execute([{ method: 'getrawmempool', params: [verbose] }], (calls) =>
        this._batchRpcCall(calls)
      );
      return results[0];
    } catch (error) {
      BitcoinErrorHandler.handleError(error, 'getRawMempool', { verbose, provider: this.type, baseUrl: this.baseUrl });
    }
  }

  public async estimateSmartFee(confTarget: number, estimateMode: string = 'CONSERVATIVE'): Promise<any> {
    try {
      const results = await this.rateLimiter.execute(
        [{ method: 'estimatesmartfee', params: [confTarget, estimateMode] }],
        (calls) => this._batchRpcCall(calls)
      );
      return results[0];
    } catch (error) {
      BitcoinErrorHandler.handleError(error, 'estimateSmartFee', {
        confTarget,
        estimateMode,
        provider: this.type,
        baseUrl: this.baseUrl,
      });
    }
  }

  // ===== NORMALIZATION METHODS (RAW RPC TO UNIVERSAL) =====

  /**
   * Normalize raw Bitcoin Core block response to UniversalBlock
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
   * Normalize raw Bitcoin Core transaction response to UniversalTransaction
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
   * Normalize raw Bitcoin Core block stats response to UniversalBlockStats
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
