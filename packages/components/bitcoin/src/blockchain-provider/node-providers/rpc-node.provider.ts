import * as http from 'node:http';
import * as https from 'node:https';
import * as zmq from 'zeromq';
import type { BaseNodeProviderOptions } from './base-node-provider';
import { BaseNodeProvider } from './base-node-provider';
import { BitcoinMerkleVerifier } from './merkle-verifier';
import type {
  NetworkConfig,
  UniversalBlock,
  UniversalTransaction,
  UniversalBlockStats,
  UniversalMempoolTransaction,
  UniversalMempoolInfo,
} from './interfaces';
import { NodeProviderTypes } from './interfaces';
import { HexTransformer } from './hex-transformer';
import { RateLimiter } from './rate-limiter';

export interface RPCNodeProviderOptions extends BaseNodeProviderOptions {
  baseUrl: string;
  network: NetworkConfig;
  responseTimeout?: number;
  // ZMQ settings (optional) - MOVED FROM P2P
  zmqEndpoint?: string;
}

export const createRPCNodeProvider = (options: RPCNodeProviderOptions): RPCNodeProvider => {
  return new RPCNodeProvider(options);
};

export class RPCNodeProvider extends BaseNodeProvider<RPCNodeProviderOptions> {
  readonly type: NodeProviderTypes = NodeProviderTypes.RPC;
  private baseUrl: string;
  private username?: string;
  private password?: string;
  private requestId = 1;
  private responseTimeout: number;
  private network: NetworkConfig;
  private rateLimiter: RateLimiter;

  // ZMQ settings - MOVED FROM P2P TO RPC
  private zmqEndpoint?: string;
  private zmqSocket?: zmq.Subscriber;
  private zmqRunning = false;

  // Subscription state
  private blockSubscriptions = new Set<(block: UniversalBlock) => void>();

  constructor(options: RPCNodeProviderOptions) {
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
    this.zmqEndpoint = options.zmqEndpoint; // ZMQ moved here

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
      zmqEndpoint: this.zmqEndpoint, // Include ZMQ in connection options
      rateLimits: this.rateLimits,
      network: this.network,
    };
  }

  /**
   * Handle connection errors and attempt recovery
   */
  async handleConnectionError(error: any, methodName: string): Promise<void> {
    // This method is called by the connection manager when operations fail
    throw error; // Re-throw to let connection manager handle provider switching
  }

  public async connect() {
    const health = await this.healthcheck();
    if (!health) {
      throw new Error('Cannot connect to the node');
    }

    // Initialize ZMQ if endpoint is provided
    if (this.zmqEndpoint) {
      await this.initializeZMQ();
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

    // 2. Clean up ZMQ subscription
    this.cleanupBlockSubscription();
    this.blockSubscriptions.clear();

    // 3. HTTPS fix - force close connections
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

    // 4. Destroy HTTP agent
    if (this._httpClient) {
      this._httpClient.destroy();
      this._httpClient = null;
    }
  }

  /**
   * Initialize ZMQ subscriber for new blocks - MOVED FROM P2P
   */
  private async initializeZMQ(): Promise<void> {
    if (!this.zmqEndpoint) return;

    try {
      this.zmqSocket = new zmq.Subscriber();
      this.zmqSocket.connect(this.zmqEndpoint);

      // Subscribe to both hash and full block notifications
      this.zmqSocket.subscribe('hashblock');
      this.zmqSocket.subscribe('rawblock');

      this.zmqRunning = true;

      // Handle new block notifications
      this.processZMQMessages();
    } catch (error) {
      this.zmqSocket = undefined;
      this.zmqRunning = false;
    }
  }

  /**
   * Process ZMQ messages - MOVED FROM P2P
   */
  private async processZMQMessages(): Promise<void> {
    if (!this.zmqSocket) return;

    try {
      for await (const [topic, message] of this.zmqSocket) {
        if (!this.zmqRunning) break;

        const topicStr = topic?.toString();

        if (topicStr === 'rawblock' && this.blockSubscriptions.size > 0) {
          const blockBuffer = message as Buffer;
          const processedBlock = await this.processNewBlock(blockBuffer);

          if (processedBlock) {
            this.blockSubscriptions.forEach((callback) => {
              try {
                callback(processedBlock);
              } catch (error) {
                // Ignore callback errors
              }
            });
          }
        } else if (topicStr === 'hashblock' && this.blockSubscriptions.size > 0) {
          const blockHash = message?.toString('hex');
          if (blockHash) {
            try {
              // Fetch the full block data using RPC
              const blocks = await this.getManyBlocksHexByHashes([blockHash], true);
              const block = blocks[0];

              if (block) {
                this.blockSubscriptions.forEach((callback) => {
                  try {
                    callback(block);
                  } catch (error) {
                    // Ignore callback errors
                  }
                });
              }
            } catch (fetchError) {
              // Block fetch failed
            }
          }
        }
      }
    } catch (error) {
      // ZMQ connection error
    }
  }

  /**
   * Process new block from ZMQ - MOVED FROM P2P
   */
  private async processNewBlock(blockData: Buffer): Promise<UniversalBlock | null> {
    try {
      const hexData = blockData.toString('hex');
      const parsedBlock = HexTransformer.parseBlockHex(hexData, this.network);
      parsedBlock.hex = hexData;

      // Verify Merkle root for security
      const isValid = BitcoinMerkleVerifier.verifyBlockMerkleRoot(parsedBlock, this.network.hasSegWit);

      if (!isValid) {
        throw new Error('TODO');
      }

      // Get height using RPC call
      try {
        const blockInfo = await this.getManyBlocksByHashes([parsedBlock.hash], 1);
        if (blockInfo[0] && blockInfo[0].height !== undefined) {
          (parsedBlock as any).height = blockInfo[0].height;
        }
      } catch (error) {
        // Could not get height, skip this block
        return null;
      }

      return parsedBlock;
    } catch (error) {
      return null;
    }
  }

  /**
   * Subscribe to new blocks with UniversalBlock - ZMQ SUBSCRIPTION
   */
  public subscribeToNewBlocks(callback: (block: UniversalBlock) => void): { unsubscribe: () => void } {
    this.blockSubscriptions.add(callback);

    if (this.blockSubscriptions.size === 1) {
      this.initializeZMQSubscription();
    }

    return {
      unsubscribe: () => {
        this.blockSubscriptions.delete(callback);
        if (this.blockSubscriptions.size === 0) {
          this.cleanupBlockSubscription();
        }
      },
    };
  }

  private initializeZMQSubscription(): void {
    if (this.zmqEndpoint && !this.zmqRunning) {
      this.initializeZMQ().catch((error) => {
        // ZMQ initialization failed
      });
    }
  }

  private cleanupBlockSubscription(): void {
    if (this.zmqSocket && this.zmqRunning) {
      this.zmqRunning = false;
      this.zmqSocket.close();
      this.zmqSocket = undefined;
    }
  }

  /**
   * Execute request with automatic error handling and provider switching
   */
  private async executeWithErrorHandling<T>(operation: () => Promise<T>, methodName: string): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      await this.handleConnectionError(error, methodName);
      throw error; // This will trigger provider switching in connection manager
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
    return this.executeWithErrorHandling(async () => {
      const results = await this.rateLimiter.execute([{ method: 'getblockcount', params: [] }], (calls) =>
        this._batchRpcCall(calls)
      );
      return results[0];
    }, 'getBlockHeight');
  }

  public async getManyBlockHashesByHeights(heights: number[]): Promise<string[]> {
    return this.executeWithErrorHandling(async () => {
      const requests = heights.map((height) => ({ method: 'getblockhash', params: [height] }));
      return await this.rateLimiter.execute(requests, (calls) => this._batchRpcCall(calls));
    }, 'getManyBlockHashesByHeights');
  }

  // ===== HEX METHODS (parse hex to Universal objects) =====

  /**
   * Get multiple blocks parsed from hex as Universal objects - ATOMIC METHOD
   * Returns blocks parsed from hex only, without height (height must be set separately)
   */
  public async getManyBlocksHexByHashes(
    hashes: string[],
    verifyMerkle: boolean = false
  ): Promise<(UniversalBlock | null)[]> {
    return this.executeWithErrorHandling(async () => {
      // Get hex data for all blocks
      const hexRequests = hashes.map((hash) => ({ method: 'getblock', params: [hash, 0] }));
      const hexResults = await this.rateLimiter.execute(hexRequests, (calls) => this._batchRpcCall(calls));

      // Parse hex to Universal blocks, preserving order
      return await Promise.all(
        hexResults.map(async (hex) => {
          if (hex === null) {
            return null; // TODO: think about this null or throw an error
          }

          // Parse hex and normalize through HexTransformer
          const parsedBlock = HexTransformer.parseBlockHex(hex, this.network);
          parsedBlock.hex = hex;

          // Verify Merkle root if requested
          if (verifyMerkle) {
            const isValid = BitcoinMerkleVerifier.verifyBlockMerkleRoot(parsedBlock, this.network.hasSegWit);
            if (!isValid) {
              throw new Error(
                `Merkle root verification failed for block ${parsedBlock.hash}. ` +
                  `Expected: ${parsedBlock.merkleroot}, but computed root doesn't match.`
              );
            }
          }

          return parsedBlock;
        })
      );
    }, 'getManyBlocksHexByHashes');
  }

  /**
   * Get multiple blocks parsed from hex by heights as Universal objects - COMBINED METHOD
   * Guarantees height for all returned blocks since we know the heights from input
   */
  public async getManyBlocksHexByHeights(
    heights: number[],
    verifyMerkle: boolean = false
  ): Promise<(UniversalBlock | null)[]> {
    return this.executeWithErrorHandling(async () => {
      // Get hashes using our internal method - preserves order with nulls
      const hashes = await this.getManyBlockHashesByHeights(heights);

      // Get hex blocks for valid hashes only
      const validHashes = hashes.filter((hash): hash is string => hash !== null);
      if (validHashes.length === 0) {
        return new Array(heights.length).fill(null);
      }

      const hexBlocks = await this.getManyBlocksHexByHashes(validHashes, verifyMerkle);

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
    }, 'getManyBlocksHexByHeights');
  }

  // ===== OBJECT METHODS (return Universal*) =====

  /**
   * Get multiple blocks as structured objects - ATOMIC METHOD
   */
  public async getManyBlocksByHashes(
    hashes: string[],
    verbosity: number = 1,
    verifyMerkle: boolean = false
  ): Promise<(UniversalBlock | null)[]> {
    return this.executeWithErrorHandling(async () => {
      const requests = hashes.map((hash) => ({ method: 'getblock', params: [hash, verbosity] }));
      const results = await this.rateLimiter.execute(requests, (calls) => this._batchRpcCall(calls));

      // Process and verify blocks if requested
      return await Promise.all(
        results.map(async (rawBlock) => {
          if (rawBlock === null) {
            return null; // TODO: think about this null or throw an error
          }

          // Verify Merkle root if requested and we have transaction data
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
    }, 'getManyBlocksByHashes');
  }

  /**
   * Get multiple blocks by heights as structured objects - COMBINED METHOD
   */
  public async getManyBlocksByHeights(
    heights: number[],
    verbosity: number = 1,
    verifyMerkle: boolean = false
  ): Promise<(UniversalBlock | null)[]> {
    return this.executeWithErrorHandling(async () => {
      // Get hashes first - preserves order, null for missing
      const blocksHashes = await this.getManyBlockHashesByHeights(heights);

      // Only request blocks for valid hashes
      const validHashes = blocksHashes.filter((hash): hash is string => hash !== null);
      if (validHashes.length === 0) {
        return new Array(heights.length).fill(null);
      }

      const blocks = await this.getManyBlocksByHashes(validHashes, verbosity, verifyMerkle);

      // Map back to original order
      const results: (UniversalBlock | null)[] = new Array(heights.length).fill(null);
      let blockIndex = 0;

      blocksHashes.forEach((hash, index) => {
        if (hash !== null) {
          results[index] = blocks[blockIndex++] || null;
        }
      });

      return results;
    }, 'getManyBlocksByHeights');
  }

  // ===== BLOCK STATS METHODS =====

  public async getManyBlocksStatsByHashes(hashes: string[]): Promise<(UniversalBlockStats | null)[]> {
    return this.executeWithErrorHandling(async () => {
      const requests = hashes.map((hash) => ({ method: 'getblockstats', params: [hash] }));
      const results = await this.rateLimiter.execute(requests, (calls) => this._batchRpcCall(calls));

      // Preserve order, normalize only non-null stats
      return results.map((rawStats) => {
        if (rawStats === null) {
          return null;
        }
        return this.normalizeRawBlockStats(rawStats);
      });
    }, 'getManyBlocksStatsByHashes');
  }

  public async getManyBlocksStatsByHeights(heights: number[]): Promise<(UniversalBlockStats | null)[]> {
    return this.executeWithErrorHandling(async () => {
      const genesisHeight = 0;
      const hasGenesis = heights.includes(genesisHeight);

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
    }, 'getManyBlocksStatsByHeights');
  }

  /**
   * Get multiple transactions as structured objects - ATOMIC METHOD
   */
  public async getManyTransactionsByTxids(
    txids: string[],
    verbosity: number = 1
  ): Promise<(UniversalTransaction | null)[]> {
    return this.executeWithErrorHandling(async () => {
      const requests = txids.map((txid) => ({
        method: 'getrawtransaction',
        params: [txid, verbosity],
      }));

      const results = await this.rateLimiter.execute(requests, (calls) => this._batchRpcCall(calls));

      // Preserve order, normalize only non-null transactions
      return results.map((rawTx) => {
        if (rawTx === null) {
          return null;
        }
        return this.normalizeRawTransaction(rawTx);
      });
    }, 'getManyTransactionsByTxids');
  }

  /**
   * Get multiple transactions parsed from hex as Universal objects - ATOMIC METHOD
   * Returns transactions parsed from hex only
   */
  public async getManyTransactionsHexByTxids(txids: string[]): Promise<(UniversalTransaction | null)[]> {
    return this.executeWithErrorHandling(async () => {
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
    }, 'getManyTransactionsHexByTxids');
  }

  // ===== NETWORK METHODS =====

  public async getBlockchainInfo(): Promise<any> {
    return this.executeWithErrorHandling(async () => {
      const results = await this.rateLimiter.execute([{ method: 'getblockchaininfo', params: [] }], (calls) =>
        this._batchRpcCall(calls)
      );
      return results[0];
    }, 'getBlockchainInfo');
  }

  public async getNetworkInfo(): Promise<any> {
    return this.executeWithErrorHandling(async () => {
      const results = await this.rateLimiter.execute([{ method: 'getnetworkinfo', params: [] }], (calls) =>
        this._batchRpcCall(calls)
      );
      return results[0];
    }, 'getNetworkInfo');
  }

  public async estimateSmartFee(confTarget: number, estimateMode: string = 'CONSERVATIVE'): Promise<any> {
    return this.executeWithErrorHandling(async () => {
      const results = await this.rateLimiter.execute(
        [{ method: 'estimatesmartfee', params: [confTarget, estimateMode] }],
        (calls) => this._batchRpcCall(calls)
      );
      return results[0];
    }, 'estimateSmartFee');
  }

  public async getMempoolInfo(): Promise<UniversalMempoolInfo> {
    return this.executeWithErrorHandling(async () => {
      const results = await this.rateLimiter.execute([{ method: 'getmempoolinfo', params: [] }], (calls) =>
        this._batchRpcCall(calls)
      );

      const rawInfo = results[0];

      if (!rawInfo) {
        throw new Error('Failed to get mempool info');
      }

      return this.normalizeMempoolInfo(rawInfo);
    }, 'getMempoolInfo');
  }

  public async getRawMempool(verbose: boolean = false): Promise<any> {
    return this.executeWithErrorHandling(async () => {
      const results = await this.rateLimiter.execute([{ method: 'getrawmempool', params: [verbose] }], (calls) =>
        this._batchRpcCall(calls)
      );

      const rawResult = results[0];

      if (!verbose) {
        return rawResult; // string[]
      }

      if (rawResult && typeof rawResult === 'object') {
        const normalizedMempool: { [txid: string]: UniversalMempoolTransaction } = {};

        for (const [txid, rawEntry] of Object.entries(rawResult)) {
          normalizedMempool[txid] = this.normalizeMempoolEntry(txid, rawEntry);
        }

        return normalizedMempool;
      }

      return rawResult;
    }, 'getRawMempool');
  }

  public async getMempoolEntries(txids: string[]): Promise<(UniversalMempoolTransaction | null)[]> {
    return this.executeWithErrorHandling(async () => {
      const requests = txids.map((txid) => ({ method: 'getmempoolentry', params: [txid] }));
      const results = await this.rateLimiter.execute(requests, (calls) => this._batchRpcCall(calls));

      return results.map((entry, index) => {
        if (entry === null) return null;
        return this.normalizeMempoolEntry(txids[index]!, entry);
      });
    }, 'getMempoolEntries');
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

  // Helper method in class:
  private coinToSmallestUnit(coinAmount: number): number {
    return Math.round(coinAmount * Math.pow(10, this.network.nativeCurrencyDecimals));
  }

  /**
   * Normalize raw Bitcoin Core mempool entry response to MempoolTransaction
   */
  private normalizeMempoolEntry(txid: string, entry: any): UniversalMempoolTransaction {
    // Extract fee values
    const baseFee = entry.fees?.base ?? entry.fee;
    const modifiedFee = entry.fees?.modified ?? entry.modifiedfee;
    const ancestorFee = entry.fees?.ancestor ?? entry.ancestorfees;
    const descendantFee = entry.fees?.descendant ?? entry.descendantfees;

    // Validation - if no base fee, this is a problem!
    if (baseFee === undefined || baseFee === null) {
      throw new Error(`Missing base fee for transaction ${txid}`);
    }

    if (!entry.vsize || entry.vsize <= 0) {
      throw new Error(`Invalid vsize for transaction ${txid}: ${entry.vsize}`);
    }

    // Convert to smallest unit if values are in coin format (< 1 indicates coin format)
    const baseFeeInSmallestUnit = baseFee < 1 ? this.coinToSmallestUnit(baseFee) : baseFee;
    const modifiedFeeInSmallestUnit =
      modifiedFee !== undefined && modifiedFee < 1 ? this.coinToSmallestUnit(modifiedFee) : modifiedFee;
    const ancestorFeeInSmallestUnit =
      ancestorFee !== undefined && ancestorFee < 1 ? this.coinToSmallestUnit(ancestorFee) : ancestorFee;
    const descendantFeeInSmallestUnit =
      descendantFee !== undefined && descendantFee < 1 ? this.coinToSmallestUnit(descendantFee) : descendantFee;

    return {
      txid,
      wtxid: entry.wtxid,
      size: entry.size, // Required field
      vsize: entry.vsize, // Required field
      weight: entry.weight, // Required field
      fee: baseFeeInSmallestUnit, // Required field
      modifiedfee: modifiedFeeInSmallestUnit ?? baseFeeInSmallestUnit, // Fallback to base fee
      time: entry.time ?? Math.floor(Date.now() / 1000),
      height: entry.height ?? -1,
      depends: entry.depends ?? [],
      descendantcount: entry.descendantcount ?? 0,
      descendantsize: entry.descendantsize ?? 0,
      descendantfees: descendantFeeInSmallestUnit ?? baseFeeInSmallestUnit,
      ancestorcount: entry.ancestorcount ?? 0,
      ancestorsize: entry.ancestorsize ?? 0,
      ancestorfees: ancestorFeeInSmallestUnit ?? baseFeeInSmallestUnit,
      fees: {
        base: baseFeeInSmallestUnit, // Required field
        modified: modifiedFeeInSmallestUnit ?? baseFeeInSmallestUnit,
        ancestor: ancestorFeeInSmallestUnit ?? baseFeeInSmallestUnit,
        descendant: descendantFeeInSmallestUnit ?? baseFeeInSmallestUnit,
      },
      bip125_replaceable: entry['bip125-replaceable'] ?? false,
      unbroadcast: entry.unbroadcast ?? false,
    };
  }

  /**
   * Normalize raw Bitcoin Core mempool info response to UniversalMempoolInfo
   * Converts fees from BTC to satoshis for consistency
   * Validates that all required fields are present
   */
  private normalizeMempoolInfo(rawInfo: any): UniversalMempoolInfo {
    // Validate required fields
    if (typeof rawInfo.size !== 'number') {
      throw new Error('Missing or invalid size in mempool info');
    }

    if (typeof rawInfo.bytes !== 'number') {
      throw new Error('Missing or invalid bytes in mempool info');
    }

    if (typeof rawInfo.maxmempool !== 'number') {
      throw new Error('Missing or invalid maxmempool in mempool info');
    }

    if (rawInfo.mempoolminfee === undefined || rawInfo.mempoolminfee === null) {
      throw new Error('Missing mempoolminfee in mempool info');
    }

    if (rawInfo.minrelaytxfee === undefined || rawInfo.minrelaytxfee === null) {
      throw new Error('Missing minrelaytxfee in mempool info');
    }

    // Convert BTC amounts to satoshis
    const totalFee =
      rawInfo.total_fee !== undefined && rawInfo.total_fee !== null ? this.coinToSmallestUnit(rawInfo.total_fee) : 0;

    // Convert fee rates from BTC/kvB to sat/vB
    // Bitcoin Core returns fee rates in BTC per 1000 virtual bytes
    // We want sat per virtual byte: (BTC/kvB) * (100,000,000 sat/BTC) / (1000 vB/kvB) = sat/vB
    const mempoolMinFee = Math.round((rawInfo.mempoolminfee * 100000000) / 1000);
    const minRelayTxFee = Math.round((rawInfo.minrelaytxfee * 100000000) / 1000);

    return {
      loaded: rawInfo.loaded === true, // Explicitly check for true
      size: rawInfo.size,
      bytes: rawInfo.bytes,
      usage: rawInfo.usage || rawInfo.bytes, // usage might be missing in older versions
      total_fee: totalFee,
      maxmempool: rawInfo.maxmempool,
      mempoolminfee: mempoolMinFee,
      minrelaytxfee: minRelayTxFee,
      unbroadcastcount: rawInfo.unbroadcastcount || 0, // This field was added later, can default
    };
  }
}
