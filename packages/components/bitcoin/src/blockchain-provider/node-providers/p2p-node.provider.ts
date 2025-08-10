import type { NetworkConfig as BitcoreNetworkConfig } from 'bitcore-p2p';
import { Pool, Peer, Messages } from 'bitcore-p2p';
import type { BaseNodeProviderOptions } from './base-node-provider';
import { BaseNodeProvider } from './base-node-provider';
import { BitcoinMerkleVerifier } from './merkle-verifier';
import type { NetworkConfig, UniversalBlock } from './interfaces';
import { NodeProviderTypes } from './interfaces';
import { HexTransformer } from './hex-transformer';
import { RateLimiter } from './rate-limiter';

/**
 * Internal chain tracker for P2P provider
 * Maintains ONLY height->hash mapping for fast block lookup by height
 * ~72 bytes per block (8 bytes height + 64 bytes hash)
 * For 870,000 blocks = ~60 MB of memory
 */
class ChainTracker {
  private heightToHash: Map<number, string> = new Map(); // height -> hash (ONLY mapping we need)
  private tipHeight: number = -1;
  private maxHeight?: number; // Optional maximum height limit for initialization

  constructor(maxHeight?: number) {
    this.maxHeight = maxHeight;
  }

  /**
   * Initialize chain tracker from RPC - loads ONLY height->hash mappings
   */
  async initialize(getBlockHashes: (heights: number[]) => Promise<string[]>, currentHeight: number): Promise<void> {
    // Determine end height - use maxHeight if specified, otherwise current height
    const endHeight = this.maxHeight !== undefined ? Math.min(this.maxHeight, currentHeight) : currentHeight;
    const startHeight = 0; // Always start from genesis

    const totalBlocks = endHeight - startHeight + 1;
    if (totalBlocks <= 0) return;

    // Load in batches to avoid overwhelming RPC
    const batchSize = 1000;
    const batches = Math.ceil(totalBlocks / batchSize);

    for (let batch = 0; batch < batches; batch++) {
      const batchStart = startHeight + batch * batchSize;
      const batchEnd = Math.min(batchStart + batchSize - 1, endHeight);
      const batchHeights = Array.from({ length: batchEnd - batchStart + 1 }, (_, i) => batchStart + i);

      try {
        // Only get block hashes - we don't need anything else
        const hashes = await getBlockHashes(batchHeights);

        // Build height->hash mapping
        hashes.forEach((hash, index) => {
          if (hash) {
            const height = batchHeights[index]!;
            this.heightToHash.set(height, hash);

            if (height > this.tipHeight) {
              this.tipHeight = height;
            }
          }
        });
      } catch (error) {
        // Continue with next batch
      }
    }
  }

  /**
   * Add new block to chain tracker (only height and hash)
   */
  addBlock(hash: string, height: number): boolean {
    // Check height limit if specified
    if (this.maxHeight !== undefined && height > this.maxHeight) {
      return false; // Don't add blocks beyond max height
    }

    // Check for reorg
    const existingHashAtHeight = this.heightToHash.get(height);
    if (existingHashAtHeight && existingHashAtHeight !== hash) {
      // Reorg detected - remove conflicting blocks
      this.handleReorg(height, hash);
      return true;
    }

    // Normal block addition
    this.heightToHash.set(height, hash);

    if (height > this.tipHeight) {
      this.tipHeight = height;
    }

    return true;
  }

  /**
   * Handle reorg - remove conflicting blocks and add new one
   */
  private handleReorg(conflictHeight: number, newHash: string): void {
    // Remove all blocks from conflict height onwards
    for (let h = conflictHeight; h <= this.tipHeight; h++) {
      this.heightToHash.delete(h);
    }

    // Add the new block
    this.heightToHash.set(conflictHeight, newHash);
    this.tipHeight = conflictHeight;
  }

  /**
   * Get block height by hash
   */
  getHeight(hash: string): number | undefined {
    // Linear search through values (rarely used)
    for (const [height, storedHash] of this.heightToHash) {
      if (storedHash === hash) {
        return height;
      }
    }
    return undefined;
  }

  /**
   * Get block hash by height (main use case)
   */
  getHash(height: number): string | undefined {
    return this.heightToHash.get(height);
  }

  /**
   * Get current chain tip height
   */
  getTipHeight(): number {
    return this.tipHeight;
  }

  /**
   * Check if we have a block at given height
   */
  hasHeight(height: number): boolean {
    return this.heightToHash.has(height);
  }

  /**
   * Get multiple hashes by heights (main use case)
   */
  getManyHashes(heights: number[]): (string | null)[] {
    return heights.map((height) => this.getHash(height) || null);
  }

  /**
   * Get total number of height-hash mappings stored
   */
  getMappingCount(): number {
    return this.heightToHash.size;
  }

  /**
   * Clear all tracking data
   */
  clear(): void {
    this.heightToHash.clear();
    this.tipHeight = -1;
  }
}

export interface P2PNodeProviderOptions extends BaseNodeProviderOptions {
  // P2P Connection settings - support multiple peers
  peers: Array<{
    host: string;
    port: number;
  }>;
  network: NetworkConfig;

  // Connection settings
  maxPeers?: number;
  connectionTimeout?: number;

  // Batch settings
  maxBatchSize?: number;

  // Chain tracking settings - ALWAYS enabled, removed enableChainTracking
  maxHeight?: number; // Optional maximum height to load (for testing or limited sync)

  // RPC provider for initialization
  rpcProvider?: any;
}

export const createP2PNodeProvider = (options: P2PNodeProviderOptions): P2PNodeProvider => {
  return new P2PNodeProvider(options);
};

export class P2PNodeProvider extends BaseNodeProvider<P2PNodeProviderOptions> {
  readonly type: NodeProviderTypes = NodeProviderTypes.P2P;

  private pool: Pool;
  private activePeer: Peer | null = null;
  private network: NetworkConfig;
  private rateLimiter: RateLimiter;
  private peers: Array<{ host: string; port: number }>;

  // Chain tracking - ALWAYS enabled
  private chainTracker: ChainTracker;
  private chainInitialized = false;
  private rpcProvider?: any;

  // Subscription state
  private blockSubscriptions = new Set<(block: UniversalBlock) => void>();

  // Connection state
  private isConnected = false;
  private connectionTimeout: number;
  private maxBatchSize: number;

  // Request tracking
  private pendingRequests = new Map<
    string,
    {
      resolve: (data: any) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
      type: 'block' | 'headers' | 'mempool';
    }
  >();

  constructor(options: P2PNodeProviderOptions) {
    super(options);

    this.peers = options.peers;
    this.network = options.network;
    this.connectionTimeout = options.connectionTimeout ?? 30000;
    this.maxBatchSize = Math.min(options.maxBatchSize ?? 2000, 2000);
    this.rateLimiter = new RateLimiter(options.rateLimits);
    this.rpcProvider = options.rpcProvider;

    // Initialize chain tracking - ALWAYS enabled
    this.chainTracker = new ChainTracker(options.maxHeight);

    // Convert our NetworkConfig to bitcore-p2p NetworkConfig
    const bitcoreNetwork = this.createBitcoreNetworkConfig();

    // Initialize P2P pool (peers will be added in connect method)
    this.pool = new Pool({
      network: bitcoreNetwork,
      maxSize: options.maxPeers ?? this.peers.length,
      dnsSeed: false,
      listenAddr: false,
    });

    this.setupPoolEventHandlers();
  }

  get connectionOptions() {
    return {
      type: this.type,
      uniqName: this.uniqName,
      peers: this.peers,
      network: this.network,
      rateLimits: this.rateLimits,
    };
  }

  /**
   * Initialize chain tracking - called during connection
   */
  private async initializeChainTracking(): Promise<void> {
    if (this.chainInitialized || !this.rpcProvider) {
      return;
    }

    try {
      const tipHeight = await this.rpcProvider.getBlockHeight();

      await this.chainTracker.initialize(
        (heights: number[]) => this.rpcProvider.getManyBlockHashesByHeights(heights),
        tipHeight
      );

      this.chainInitialized = true;
    } catch (error) {
      // Chain tracking initialization failed, disable it
      throw new Error(`P2P chain tracking initialization failed: ${error}`);
    }
  }

  /**
   * Convert our NetworkConfig to bitcore-p2p NetworkConfig
   */
  private createBitcoreNetworkConfig(): BitcoreNetworkConfig {
    return {
      name: this.network.network,
      pubkeyhash: 0x00,
      privatekey: 0x80,
      scripthash: 0x05,
      xpubkey: 0x0488b21e,
      xprivkey: 0x0488ade4,
      networkMagic: this.network.magicBytes ?? 0xf9beb4d9,
      port: this.network.defaultPort ?? 8333,
    };
  }

  /**
   * Setup event handlers for P2P pool
   */
  private setupPoolEventHandlers(): void {
    this.pool.on('peerready', (peer: Peer) => {
      if (!this.activePeer) {
        this.activePeer = peer;
        this.isConnected = true;
        this.setupPeerEventHandlers(peer);
      }
    });

    this.pool.on('peerdisconnect', (peer: Peer, addr: string) => {
      if (this.activePeer === peer) {
        this.activePeer = null;
        this.isConnected = false;

        // Try to switch to another connected peer
        if (this.pool._connectedPeers && this.pool._connectedPeers.size > 0) {
          const nextPeer = Array.from(this.pool._connectedPeers.values())[0];
          if (nextPeer) {
            this.activePeer = nextPeer;
            this.isConnected = true;
            this.setupPeerEventHandlers(nextPeer);
          }
        }
      }
    });

    this.pool.on('peererror', (peer: Peer, error: any) => {
      // Handle peer errors gracefully
    });
  }

  /**
   * Setup event handlers for individual peer
   */
  private setupPeerEventHandlers(peer: Peer): void {
    // Handle block messages - NEW BLOCKS COME VIA P2P
    peer.on('block', (message: any) => {
      if (!message?.block?.hash || !message?.block?.toBuffer) {
        return;
      }

      const blockHash = message.block.hash.toString('hex');

      // Check if this is a response to our request
      this.handleBlockResponse(blockHash, message.block.toBuffer());

      // Also process as new block if we have subscriptions
      if (this.blockSubscriptions.size > 0) {
        this.processNewBlock(message.block.toBuffer(), blockHash);
      }
    });

    // Handle headers messages
    peer.on('headers', (message: any) => {
      if (message?.headers) {
        this.handleHeadersResponse(message.headers);
      }
    });

    // Handle ping/pong for connection health
    peer.on('ping', (message: any) => {
      if (message?.nonce) {
        peer.sendMessage(new Messages.Pong(message.nonce));
      }
    });
  }

  /**
   * Handle block response from peer
   */
  private handleBlockResponse(blockHash: string, blockBuffer: Buffer): void {
    const request = this.pendingRequests.get(blockHash);
    if (request && request.type === 'block') {
      clearTimeout(request.timeout);
      this.pendingRequests.delete(blockHash);

      try {
        const hexData = blockBuffer.toString('hex');
        const parsedBlock = HexTransformer.parseBlockHex(hexData, this.network);
        parsedBlock.hex = hexData;

        // Enrich with height from chain tracker
        this.enrichBlockWithHeight(parsedBlock);

        request.resolve(parsedBlock);
      } catch (error) {
        request.reject(new Error(`Failed to parse block: ${error}`));
      }
    }
  }

  /**
   * Handle headers response from peer - ADDED MISSING METHOD
   */
  private handleHeadersResponse(headers: any[]): void {
    // Process received headers and update chain tracker
    headers.forEach((header) => {
      if (header?.hash && header?.height !== undefined) {
        const blockHash = header.hash.toString('hex');
        this.chainTracker.addBlock(blockHash, header.height);
      }
    });
  }

  /**
   * Enrich block with height from chain tracker
   */
  private enrichBlockWithHeight(block: UniversalBlock): void {
    if (!block.height) {
      const height = this.chainTracker.getHeight(block.hash);
      if (height !== undefined) {
        block.height = height;
      }
    }
  }

  /**
   * Process new block from P2P network - FIXED LOGIC
   * Determines height immediately and handles reorgs properly
   */
  private async processNewBlock(blockData: Buffer, blockHash?: string): Promise<UniversalBlock | null> {
    try {
      const hexData = blockData.toString('hex');
      const parsedBlock = HexTransformer.parseBlockHex(hexData, this.network);
      parsedBlock.hex = hexData;

      // Use provided hash if available, otherwise use parsed hash
      const hash = blockHash || parsedBlock.hash;

      // Verify Merkle root for security
      const isValid = BitcoinMerkleVerifier.verifyBlockMerkleRoot(parsedBlock, this.network.hasSegWit);

      if (!isValid) {
        return null; // Skip blocks with invalid Merkle root
      }

      // Determine height immediately
      let height = this.chainTracker.getHeight(hash);

      if (height === undefined) {
        // Try to determine height from previous block
        if (parsedBlock.previousblockhash) {
          const prevHeight = this.chainTracker.getHeight(parsedBlock.previousblockhash);
          if (prevHeight !== undefined) {
            height = prevHeight + 1;
            // This is the next block in the chain
            this.chainTracker.addBlock(hash, height);
          } else {
            // Previous block not found - possible reorg or gap in chain
            // For now, we cannot determine height reliably
            return null;
          }
        } else {
          // Genesis block case
          if (this.chainTracker.getTipHeight() === -1) {
            height = 0;
            this.chainTracker.addBlock(hash, height);
          } else {
            // Genesis block but we already have blocks - suspicious
            return null;
          }
        }
      } else {
        // We already know this block - check for reorg
        const existingHash = this.chainTracker.getHash(height);
        if (existingHash && existingHash !== hash) {
          // Reorg detected! Add the new block (ChainTracker handles reorg)
          this.chainTracker.addBlock(hash, height);
        }
      }

      // Set the determined height
      (parsedBlock as any).height = height;

      return parsedBlock;
    } catch (error) {
      return null;
    }
  }

  /**
   * Subscribe to new blocks with UniversalBlock - BLOCKS COME VIA P2P
   */
  public subscribeToNewBlocks(callback: (block: UniversalBlock) => void): { unsubscribe: () => void } {
    this.blockSubscriptions.add(callback);

    // P2P blocks are received via peer 'block' events - no additional setup needed

    return {
      unsubscribe: () => {
        this.blockSubscriptions.delete(callback);
      },
    };
  }

  async handleConnectionError(error: any, methodName: string): Promise<void> {
    throw error;
  }

  public async connect(): Promise<void> {
    // Initialize chain tracking first - ALWAYS enabled
    if (this.rpcProvider) {
      await this.initializeChainTracking();
    }

    // Add all peers to the pool
    this.peers.forEach((peerConfig) => {
      const peer = new Peer({
        host: peerConfig.host,
        port: peerConfig.port,
      });
      this.pool.addPeer(peer);
    });

    // Connect P2P pool
    this.pool.connect();

    // Wait for peer connection
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('P2P connection timeout'));
      }, this.connectionTimeout);

      this.pool.once('peerready', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  public async healthcheck(): Promise<boolean> {
    return this.isConnected && this.activePeer !== null;
  }

  public async disconnect(): Promise<void> {
    await this.rateLimiter.stop();

    for (const [key, request] of this.pendingRequests) {
      clearTimeout(request.timeout);
      request.reject(new Error('Provider disconnecting'));
    }
    this.pendingRequests.clear();

    this.blockSubscriptions.clear();

    this.chainTracker.clear();
    this.chainInitialized = false;

    this.pool.disconnect();
    this.activePeer = null;
    this.isConnected = false;
  }

  private async executeWithErrorHandling<T>(operation: () => Promise<T>, methodName: string): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      await this.handleConnectionError(error, methodName);
      throw error;
    }
  }

  /**
   * Request blocks from P2P peer with proper timeout handling
   */
  private async requestBlocks(hashes: string[]): Promise<UniversalBlock[]> {
    if (!this.activePeer) {
      throw new Error('No active peer connection');
    }

    return new Promise<UniversalBlock[]>((resolve, reject) => {
      const expectedHashes = new Set(hashes);
      const receivedBlocks = new Map<string, UniversalBlock>();

      // Calculate reasonable timeout: base + per-block time
      const timeoutMs = Math.min(120000, 10000 + hashes.length * 500); // 10s base + 500ms per block, max 2min

      const cleanup = () => {
        this.activePeer?.removeListener('block', onBlock);
      };

      const timeoutHandle = setTimeout(() => {
        cleanup();
        reject(new Error(`Batch request timeout after ${timeoutMs}ms for ${hashes.length} blocks`));
      }, timeoutMs);

      const onBlock = (message: any) => {
        if (!message?.block?.hash || !message?.block?.toBuffer) {
          return;
        }

        const blockHash = message.block.hash.toString('hex');
        if (!expectedHashes.has(blockHash)) {
          return; // Not our block
        }

        try {
          const hexData = message.block.toBuffer().toString('hex');
          const parsedBlock = HexTransformer.parseBlockHex(hexData, this.network);
          parsedBlock.hex = hexData;

          this.enrichBlockWithHeight(parsedBlock);

          receivedBlocks.set(blockHash, parsedBlock);
          expectedHashes.delete(blockHash);

          // Check if we got all blocks
          if (expectedHashes.size === 0) {
            clearTimeout(timeoutHandle);
            cleanup();
            const result = hashes.map((hash) => receivedBlocks.get(hash)!);
            resolve(result);
          }
        } catch (error) {
          // Skip invalid blocks but continue waiting for others
          expectedHashes.delete(blockHash);
          if (expectedHashes.size === 0) {
            clearTimeout(timeoutHandle);
            cleanup();
            const result = hashes.map((hash) => receivedBlocks.get(hash) || null).filter(Boolean);
            resolve(result as UniversalBlock[]);
          }
        }
      };

      this.activePeer!.on('block', onBlock);

      try {
        const inventory = hashes.map((hash) => ({
          type: 2, // MSG_BLOCK
          hash: Buffer.from(hash, 'hex').reverse(),
        }));

        const getDataMessage = new Messages.GetData(inventory);

        if (!this.activePeer) {
          clearTimeout(timeoutHandle);
          cleanup();
          reject(new Error('Active peer disconnected during batch request'));
          return;
        }

        this.activePeer.sendMessage(getDataMessage);
      } catch (error) {
        clearTimeout(timeoutHandle);
        cleanup();
        reject(new Error(`Failed to send batch request: ${error}`));
      }
    });
  }

  private chunkArray<T>(array: T[], chunkSize: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += chunkSize) {
      chunks.push(array.slice(i, i + chunkSize));
    }
    return chunks;
  }

  // ===== BASIC BLOCKCHAIN METHODS =====

  public async getBlockHeight(): Promise<number> {
    return this.executeWithErrorHandling(async () => {
      const tipHeight = this.chainTracker.getTipHeight();
      if (tipHeight >= 0) {
        return tipHeight;
      }
      throw new Error('getBlockHeight not available - chain tracker not initialized');
    }, 'getBlockHeight');
  }

  public async getManyBlockHashesByHeights(heights: number[]): Promise<string[]> {
    return this.executeWithErrorHandling(async () => {
      return this.chainTracker.getManyHashes(heights).filter((block) => block !== null) as string[];
    }, 'getManyBlockHashesByHeights');
  }

  // ===== HEX METHODS =====

  public async getManyBlocksHexByHashes(
    hashes: string[],
    verifyMerkle: boolean = false
  ): Promise<(UniversalBlock | null)[]> {
    return this.executeWithErrorHandling(async () => {
      if (!this.activePeer) {
        throw new Error('No active peer connection');
      }

      const chunks = this.chunkArray(hashes, this.maxBatchSize);
      const results: (UniversalBlock | null)[] = [];

      for (const chunk of chunks) {
        const chunkResults = await this.rateLimiter.execute(
          chunk.map((hash) => ({ method: 'getblock', params: [hash] })),
          async () => {
            try {
              const blocks = await this.requestBlocks(chunk);

              if (verifyMerkle) {
                return await Promise.all(
                  blocks.map(async (block) => {
                    if (!block) return null;

                    const isValid = BitcoinMerkleVerifier.verifyBlockMerkleRoot(block, this.network.hasSegWit);
                    if (!isValid) {
                      throw new Error(
                        `Merkle root verification failed for block ${block.hash}. ` +
                          `Expected: ${block.merkleroot}, but computed root doesn't match.`
                      );
                    }
                    return block;
                  })
                );
              }

              return blocks;
            } catch (error) {
              return new Array(chunk.length).fill(null);
            }
          }
        );

        results.push(...chunkResults);
      }

      return results;
    }, 'getManyBlocksHexByHashes');
  }

  public async getManyBlocksHexByHeights(
    heights: number[],
    verifyMerkle: boolean = false
  ): Promise<(UniversalBlock | null)[]> {
    return this.executeWithErrorHandling(async () => {
      const hashes = this.chainTracker.getManyHashes(heights);
      const validHashes = hashes.filter((hash): hash is string => hash !== null);

      if (validHashes.length === 0) {
        return new Array(heights.length).fill(null);
      }

      const blocks = await this.getManyBlocksHexByHashes(validHashes, verifyMerkle);

      const results: (UniversalBlock | null)[] = new Array(heights.length).fill(null);
      let blockIndex = 0;

      hashes.forEach((hash, index) => {
        if (hash !== null) {
          const block = blocks[blockIndex++] || null;
          if (block !== null) {
            block.height = heights[index]; // Guarantee height from input
            results[index] = block;
          }
        }
      });

      return results;
    }, 'getManyBlocksHexByHeights');
  }

  // ===== OBJECT METHODS =====

  public async getManyBlocksByHashes(
    hashes: string[],
    verbosity: number = 1,
    verifyMerkle: boolean = false
  ): Promise<(UniversalBlock | null)[]> {
    // For P2P, we always get full block data (equivalent to verbosity = 1)
    return this.getManyBlocksHexByHashes(hashes, verifyMerkle);
  }

  public async getManyBlocksByHeights(
    heights: number[],
    verbosity: number = 1,
    verifyMerkle: boolean = false
  ): Promise<(UniversalBlock | null)[]> {
    return this.getManyBlocksHexByHeights(heights, verifyMerkle);
  }
}
