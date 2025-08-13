import type { NetworkConfig as BitcoreNetworkConfig } from 'bitcore-p2p';
import { Pool, Peer, Messages } from 'bitcore-p2p';
import type { BaseTransportOptions } from './base.transport';
import { BaseTransport } from './base.transport';

/**
 * P2P Transport for Bitcoin-compatible blockchain communication
 *
 * Architecture:
 * - Direct P2P protocol communication with Bitcoin-compatible nodes (BTC, BCH, DOGE, LTC)
 * - ChainTracker maintains height->hash mapping for height-based queries
 * - Handles header synchronization and real-time block updates
 * - Supports block subscriptions and automatic reorganization detection
 *
 * Memory usage: ~72 bytes per block for height->hash mapping
 * For 870,000 blocks ≈ 60 MB of memory
 *
 * Performance:
 * - Header sync: O(n) where n = number of blocks to sync
 * - Block retrieval: O(1) height->hash lookup + O(k) network requests
 * - Reorg handling: O(m) where m = blocks from conflict point to tip
 */

export interface P2PTransportOptions extends BaseTransportOptions {
  peers: Array<{ host: string; port: number }>;
  maxPeers?: number;
  connectionTimeout?: number;
  maxBatchSize?: number;
  maxHeight?: number; // Optional maximum height to sync (for testing or limited sync)
  headerSyncEnabled?: boolean; // Enable header synchronization on connect
  headerSyncBatchSize?: number; // Batch size for header requests
}

/**
 * Internal chain tracker for P2P transport
 *
 * Purpose: Maintains height->hash mapping for fast block lookup by height
 * Memory usage: ~72 bytes per block for 870,000 blocks = ~60 MB
 *
 * Essential for P2P because protocol works with hashes but applications need height-based access
 * Reorg handling: Automatically detects conflicts and rebuilds chain from new branch
 */
class ChainTracker {
  private heightToHash: Map<number, string> = new Map();
  private tipHeight: number = -1;
  private maxHeight?: number;

  constructor(maxHeight?: number) {
    this.maxHeight = maxHeight;
  }

  /**
   * Add block header to chain tracker
   * Automatically handles blockchain reorganizations by detecting conflicts
   * Time complexity: O(1) for normal blocks, O(m) for reorgs where m = blocks from conflict point
   */
  addHeader(hash: string, height: number): boolean {
    // Check height limit if specified
    if (this.maxHeight !== undefined && height > this.maxHeight) {
      return false;
    }

    // Check for reorg
    const existingHashAtHeight = this.heightToHash.get(height);
    if (existingHashAtHeight && existingHashAtHeight !== hash) {
      this.handleReorg(height, hash);
      return true;
    }

    // Normal header addition
    this.heightToHash.set(height, hash);

    if (height > this.tipHeight) {
      this.tipHeight = height;
    }

    return true;
  }

  /**
   * Handle blockchain reorganization
   * When different hash appears at existing height, remove all blocks from that point
   * Time complexity: O(m) where m = blocks from conflict height to tip
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
   * Time complexity: O(n) where n = number of stored blocks
   */
  getHeight(hash: string): number | undefined {
    for (const [height, storedHash] of this.heightToHash) {
      if (storedHash === hash) {
        return height;
      }
    }
    return undefined;
  }

  /**
   * Get block hash by height
   * Time complexity: O(1)
   */
  getHash(height: number): string | undefined {
    return this.heightToHash.get(height);
  }

  /**
   * Get current chain tip height
   * Time complexity: O(1)
   */
  getTipHeight(): number {
    return this.tipHeight;
  }

  /**
   * Check if we have a block at given height
   * Time complexity: O(1)
   */
  hasHeight(height: number): boolean {
    return this.heightToHash.has(height);
  }

  /**
   * Get multiple hashes by heights - preserves order with nulls for missing heights
   * Time complexity: O(k) where k = number of heights requested
   */
  getManyHashes(heights: number[]): (string | null)[] {
    return heights.map((height) => this.getHash(height) || null);
  }

  /**
   * Get total number of height-hash mappings stored
   * Time complexity: O(1)
   */
  getMappingCount(): number {
    return this.heightToHash.size;
  }

  /**
   * Clear all tracking data
   * Time complexity: O(1)
   */
  clear(): void {
    this.heightToHash.clear();
    this.tipHeight = -1;
  }

  /**
   * Get sync progress as percentage
   * Time complexity: O(1)
   */
  getSyncProgress(currentTipHeight: number): number {
    if (currentTipHeight === 0) return 100;
    return Math.min(100, (this.tipHeight / currentTipHeight) * 100);
  }
}

export class P2PTransport extends BaseTransport<P2PTransportOptions> {
  readonly type = 'P2P';

  private pool: Pool;
  private activePeer: Peer | null = null;
  private peers: Array<{ host: string; port: number }>;
  private connectionTimeout: number;
  private maxBatchSize: number;
  private headerSyncEnabled: boolean;
  private headerSyncBatchSize: number;

  // Chain tracking
  private chainTracker: ChainTracker;
  private headerSyncComplete = false;

  // Block subscription callback - NOT stored, just passed through
  private blockSubscriptionCallback: ((blockData: Buffer) => void) | null = null;

  // Request tracking for batch operations
  private pendingRequests = new Map<
    string,
    {
      resolve: (data: any) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >();

  // Header sync tracking
  private headerSyncPromise: Promise<void> | null = null;

  constructor(options: P2PTransportOptions) {
    super(options);

    this.peers = options.peers;
    this.connectionTimeout = options.connectionTimeout ?? 30000;
    this.maxBatchSize = Math.min(options.maxBatchSize ?? 2000, 2000);
    this.headerSyncEnabled = options.headerSyncEnabled ?? true;
    this.headerSyncBatchSize = options.headerSyncBatchSize ?? 2000;

    // Initialize chain tracker
    this.chainTracker = new ChainTracker(options.maxHeight);

    // Convert network config to bitcore format
    const bitcoreNetwork = this.createBitcoreNetworkConfig();

    this.pool = new Pool({
      network: bitcoreNetwork,
      maxSize: options.maxPeers ?? this.peers.length,
      dnsSeed: false,
      listenAddr: false,
    });

    this.setupPoolEventHandlers();
  }

  get connectionOptions(): P2PTransportOptions {
    return {
      uniqName: this.uniqName,
      peers: this.peers,
      rateLimits: this.rateLimiter['config'],
      network: this.network,
      maxPeers: this.peers.length,
      connectionTimeout: this.connectionTimeout,
      maxBatchSize: this.maxBatchSize,
      headerSyncEnabled: this.headerSyncEnabled,
      headerSyncBatchSize: this.headerSyncBatchSize,
    };
  }

  async connect(): Promise<void> {
    return this.executeWithErrorHandling(async () => {
      // Add all peers to pool
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
          this.isConnected = true;
          resolve();
        });
      });

      // Initialize header sync if enabled
      if (this.headerSyncEnabled) {
        this.headerSyncPromise = this.initializeHeaderSync();
        // Don't wait for header sync to complete - it runs in background
      }
    }, 'connect');
  }

  async healthcheck(): Promise<boolean> {
    return this.isConnected && this.activePeer !== null;
  }

  /**
   * Get current blockchain height from chain tracker
   * Node calls: 0 (uses cached data)
   * Time complexity: O(1)
   */
  async getBlockHeight(): Promise<number> {
    return this.executeWithErrorHandling(async () => {
      const tipHeight = this.chainTracker.getTipHeight();
      if (tipHeight >= 0) {
        return tipHeight;
      }
      throw new Error('Block height not available - header sync not complete');
    }, 'getBlockHeight');
  }

  /**
   * Get block hashes by heights - uses chain tracker
   * Node calls: 0 (uses cached data)
   * Time complexity: O(k) where k = number of heights requested
   * @returns Array preserving order with nulls for missing heights
   */
  async getManyBlockHashesByHeights(heights: number[]): Promise<(string | null)[]> {
    return this.executeWithErrorHandling(async () => {
      // If header sync is not complete, wait a bit or return what we have
      if (!this.headerSyncComplete && this.headerSyncPromise) {
        // Give header sync some time, but don't block indefinitely
        try {
          await Promise.race([
            this.headerSyncPromise,
            new Promise((resolve) => setTimeout(resolve, 5000)), // 5 second max wait
          ]);
        } catch {
          // Continue with partial data
        }
      }

      return this.chainTracker.getManyHashes(heights);
    }, 'getManyBlockHashesByHeights');
  }

  /**
   * Request blocks via P2P protocol
   * Node calls: 1 (GetData message with block inventory)
   * Time complexity: O(k) where k = number of blocks requested
   * @returns Array of block buffers in same order as input hashes
   */
  async requestBlocks(hashes: string[]): Promise<Buffer[]> {
    return this.executeWithErrorHandling(async () => {
      if (!this.activePeer) {
        throw new Error('No active peer connection');
      }

      return new Promise<Buffer[]>((resolve, reject) => {
        const expectedHashes = new Set(hashes);
        const receivedBlocks = new Map<string, Buffer>();
        const timeoutMs = Math.min(120000, 10000 + hashes.length * 500);

        const cleanup = () => {
          this.activePeer?.removeListener('block', onBlock);
        };

        const timeoutHandle = setTimeout(() => {
          cleanup();
          reject(new Error(`Block request timeout after ${timeoutMs}ms for ${hashes.length} blocks`));
        }, timeoutMs);

        const onBlock = (message: any) => {
          if (!message?.block?.hash || !message?.block?.toBuffer) {
            return;
          }

          const blockHash = message.block.hash.toString('hex');
          if (!expectedHashes.has(blockHash)) {
            return;
          }

          const blockBuffer = message.block.toBuffer();
          receivedBlocks.set(blockHash, blockBuffer);
          expectedHashes.delete(blockHash);

          if (expectedHashes.size === 0) {
            clearTimeout(timeoutHandle);
            cleanup();
            const result = hashes.map((hash) => receivedBlocks.get(hash)!);
            resolve(result);
          }
        };

        this.activePeer!.on('block', onBlock);

        try {
          const inventory = hashes.map((hash) => ({
            type: 2, // MSG_BLOCK
            hash: Buffer.from(hash, 'hex').reverse(),
          }));

          const getDataMessage = new Messages.GetData(inventory);
          this.activePeer!.sendMessage(getDataMessage);
        } catch (error) {
          clearTimeout(timeoutHandle);
          cleanup();
          reject(new Error(`Failed to send block request: ${error}`));
        }
      });
    }, 'requestBlocks');
  }

  /**
   * P2P doesn't support traditional RPC calls
   * This method is for compatibility but will throw for unsupported operations
   */
  async batchCall<TResult = any>(calls: Array<{ method: string; params: any[] }>): Promise<TResult[]> {
    // Check if this is a supported P2P operation
    for (const call of calls) {
      if (call.method === 'getblockhash') {
        // Handle getblockhash calls using chain tracker
        const results = await Promise.all(
          calls.map(async (c) => {
            if (c.method === 'getblockhash' && typeof c.params[0] === 'number') {
              return this.chainTracker.getHash(c.params[0]) || null;
            }
            throw new Error(`Unsupported P2P method: ${c.method}`);
          })
        );
        return results as TResult[];
      }

      if (call.method === 'getblockcount') {
        // Handle getblockcount using chain tracker
        return [this.chainTracker.getTipHeight()] as TResult[];
      }
    }

    // P2P only supports specific operations like requesting blocks
    this.throwNotImplemented('batchCall for general RPC methods');
  }

  /**
   * Subscribe to new blocks - only one active subscription allowed
   * Blocks are passed through immediately and used to update chain tracker
   * Node calls: 0 (real-time P2P messages)
   */
  subscribeToNewBlocks(callback: (blockData: Buffer) => void): { unsubscribe: () => void } {
    this.blockSubscriptionCallback = callback;

    return {
      unsubscribe: () => {
        this.blockSubscriptionCallback = null;
      },
    };
  }

  async disconnect(): Promise<void> {
    await this.rateLimiter.stop();

    // Clear pending requests
    for (const [key, request] of this.pendingRequests) {
      clearTimeout(request.timeout);
      request.reject(new Error('Transport disconnecting'));
    }
    this.pendingRequests.clear();
    this.blockSubscriptionCallback = null;

    // Clear chain tracking
    this.chainTracker.clear();
    this.headerSyncComplete = false;
    this.headerSyncPromise = null;

    this.pool.disconnect();
    this.activePeer = null;
    this.isConnected = false;
  }

  /**
   * Initialize header synchronization from trusted peer (your own node)
   * Downloads headers from genesis to current tip to build height->hash mapping
   * Time complexity: O(n) where n = number of blocks to sync
   */
  private async initializeHeaderSync(): Promise<void> {
    if (!this.activePeer) {
      throw new Error('No active peer for header sync');
    }

    try {
      // Start header sync from trusted peer (your own nodes)
      await this.syncAllHeadersFromTrustedPeer();
      this.headerSyncComplete = true;
    } catch (error) {
      // Header sync failed, transport should still work without it
    }
  }

  /**
   * Sync all headers from trusted peer (your own node)
   * Since it's your node, we can trust it and request headers efficiently
   */
  private async syncAllHeadersFromTrustedPeer(): Promise<void> {
    if (!this.activePeer) {
      throw new Error('No active peer for header sync');
    }

    let receivedHeadersCount = 0;
    let currentHeight = 0;

    // Keep requesting headers until we get less than 2000 (meaning we reached the tip)
    while (true) {
      try {
        const headers = await this.requestHeadersBatch();

        if (!headers || headers.length === 0) {
          // No more headers to sync
          break;
        }

        // Process received headers and calculate heights
        for (let i = 0; i < headers.length; i++) {
          const header = headers[i];
          if (!header) continue; // Skip undefined headers

          const height = currentHeight + i;

          // Check maxHeight limit if specified
          if (this.chainTracker['maxHeight'] !== undefined && height > this.chainTracker['maxHeight']) {
            // Reached maxHeight limit, stop syncing
            return;
          }

          this.chainTracker.addHeader(header.hash, height);
        }

        receivedHeadersCount += headers.length;
        currentHeight += headers.length;

        // If we received less than 2000 headers, we've reached the tip
        if (headers.length < 2000) {
          // Reached blockchain tip
          break;
        }
      } catch (error) {
        // Header sync batch failed, stop syncing
        break;
      }
    }
  }

  /**
   * Request a batch of headers from peer
   * For trusted peers, we use simple sequential requests
   */
  private async requestHeadersBatch(): Promise<Array<{ hash: string; previousblockhash: string }> | null> {
    if (!this.activePeer) {
      throw new Error('No active peer available');
    }

    return new Promise<Array<{ hash: string; previousblockhash: string }> | null>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Header batch request timeout'));
      }, 30000);

      // Build locator based on our current state
      const locator = this.buildSimpleLocator();

      const getHeadersMessage = new Messages.GetHeaders({
        starts: locator,
        stop: Buffer.alloc(32), // Zero hash means "give me all available"
      });

      const onHeaders = (message: any) => {
        this.activePeer?.removeListener('headers', onHeaders);
        clearTimeout(timeout);

        try {
          if (!message?.headers) {
            resolve([]);
            return;
          }

          const parsedHeaders = message.headers.map((headerBuffer: Buffer) => {
            return this.parseHeaderBuffer(headerBuffer);
          });

          resolve(parsedHeaders);
        } catch (error) {
          reject(new Error(`Failed to parse headers: ${error}`));
        }
      };

      this.activePeer!.on('headers', onHeaders);
      this.activePeer!.sendMessage(getHeadersMessage);
    });
  }

  /**
   * Build simple locator for trusted peer
   * Since it's your node, we can use a simpler approach
   */
  private buildSimpleLocator(): Buffer[] {
    const tipHeight = this.chainTracker.getTipHeight();

    if (tipHeight < 0) {
      // No headers yet, return empty locator (start from genesis)
      return [];
    }

    // For trusted peer, just use the tip hash as locator
    const tipHash = this.chainTracker.getHash(tipHeight);
    if (tipHash) {
      return [Buffer.from(tipHash, 'hex').reverse()]; // Bitcoin uses little-endian
    }

    return [];
  }

  /**
   * Parse header from raw buffer and extract essential information
   */
  private parseHeaderBuffer(headerBuffer: Buffer): {
    hash: string;
    previousblockhash: string;
    merkleroot: string;
    time: number;
    bits: string;
    nonce: number;
  } {
    if (headerBuffer.length !== 80) {
      throw new Error(`Invalid header length: ${headerBuffer.length}, expected 80`);
    }

    // Bitcoin header structure (80 bytes):
    // version (4) + prevHash (32) + merkleRoot (32) + time (4) + bits (4) + nonce (4)

    const previousblockhash = headerBuffer.slice(4, 36).reverse().toString('hex');
    const merkleroot = headerBuffer.slice(36, 68).reverse().toString('hex');
    const time = headerBuffer.readUInt32LE(68);
    const bits = headerBuffer.slice(72, 76).toString('hex');
    const nonce = headerBuffer.readUInt32LE(76);

    // Calculate hash by double SHA256 of the header
    const crypto = require('crypto');
    const hash1 = crypto.createHash('sha256').update(headerBuffer).digest();
    const hash2 = crypto.createHash('sha256').update(hash1).digest();
    const hash = hash2.reverse().toString('hex');

    return {
      hash,
      previousblockhash,
      merkleroot,
      time,
      bits,
      nonce,
    };
  }

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

  private setupPoolEventHandlers(): void {
    this.pool.on('peerready', (peer: Peer) => {
      if (!this.activePeer) {
        this.activePeer = peer;
        this.setupPeerEventHandlers(peer);
      }
    });

    this.pool.on('peerdisconnect', (peer: Peer) => {
      if (this.activePeer === peer) {
        this.activePeer = null;
        // Try to switch to another connected peer
        if (this.pool._connectedPeers && this.pool._connectedPeers.size > 0) {
          const nextPeer = Array.from(this.pool._connectedPeers.values())[0];
          if (nextPeer) {
            this.activePeer = nextPeer;
            this.setupPeerEventHandlers(nextPeer);
          }
        }
      }
    });
  }

  private setupPeerEventHandlers(peer: Peer): void {
    // Handle incoming blocks - immediately pass through to subscriber and update chain tracker
    peer.on('block', (message: any) => {
      if (!message?.block?.toBuffer) return;

      const blockBuffer = message.block.toBuffer();

      // Pass block to subscriber immediately if exists
      if (this.blockSubscriptionCallback) {
        try {
          this.blockSubscriptionCallback(blockBuffer);
        } catch (error) {
          // Ignore subscriber callback errors
        }
      }

      // Extract block hash and try to determine height for chain tracking
      try {
        const blockHash = message.block.hash?.toString('hex');
        if (blockHash) {
          // Try to determine height from previousblockhash chain
          const prevHash = this.extractPreviousBlockHash(blockBuffer);
          const prevHeight = prevHash ? this.chainTracker.getHeight(prevHash) : undefined;

          if (prevHeight !== undefined) {
            const newHeight = prevHeight + 1;
            // Add new block to chain tracker (handles reorgs automatically)
            this.chainTracker.addHeader(blockHash, newHeight);
          } else {
            // If we can't determine height from chain, try to parse header and calculate
            // This might happen if we receive a block before its parent is in our chain tracker
            this.tryToAddBlockWithCalculatedHeight(blockHash, blockBuffer);
          }
        }
      } catch (error) {
        // Ignore chain tracking errors for live blocks
      }
    });

    // Handle incoming headers for real-time chain updates
    peer.on('headers', (message: any) => {
      if (message?.headers) {
        message.headers.forEach((headerBuffer: Buffer) => {
          try {
            const header = this.parseHeaderBuffer(headerBuffer);
            // Try to determine height from chain
            const prevHeight = this.chainTracker.getHeight(header.previousblockhash);
            if (prevHeight !== undefined) {
              const height = prevHeight + 1;
              // ChainTracker.addHeader automatically handles reorgs
              this.chainTracker.addHeader(header.hash, height);
            }
          } catch (error) {
            // Ignore header processing errors
          }
        });
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
   * Try to add block with calculated height when parent is not in chain tracker
   * This is a fallback for blocks received before their parents
   */
  private tryToAddBlockWithCalculatedHeight(blockHash: string, blockBuffer: Buffer): void {
    try {
      // Extract timestamp and try to estimate height based on average block time
      // This is rough estimation and should only be used as fallback
      const timestamp = blockBuffer.readUInt32LE(68); // timestamp at offset 68 in block header
      const currentTime = Math.floor(Date.now() / 1000);

      // Bitcoin target block time is 10 minutes (600 seconds)
      // This is very rough estimation and might be inaccurate
      if (timestamp > 0 && timestamp <= currentTime) {
        const currentTip = this.chainTracker.getTipHeight();
        if (currentTip >= 0) {
          // Assume this is likely the next block after current tip
          const estimatedHeight = currentTip + 1;
          this.chainTracker.addHeader(blockHash, estimatedHeight);
        }
      }
    } catch {
      // Ignore estimation errors
    }
  }

  /**
   * Extract previous block hash from block buffer
   * Bitcoin block structure: version(4) + prevHash(32) + ...
   */
  private extractPreviousBlockHash(blockBuffer: Buffer): string | null {
    try {
      if (blockBuffer.length < 36) return null;
      // Previous block hash is at bytes 4-35, reversed for display
      return blockBuffer.slice(4, 36).reverse().toString('hex');
    } catch {
      return null;
    }
  }

  /**
   * Check if header sync is complete
   */
  isHeaderSyncComplete(): boolean {
    return this.headerSyncComplete;
  }

  /**
   * Get header sync progress
   */
  async getHeaderSyncProgress(): Promise<{ synced: number; total: number; percentage: number }> {
    const synced = this.chainTracker.getMappingCount();
    const tipHeight = this.chainTracker.getTipHeight();

    return {
      synced,
      total: Math.max(synced, tipHeight + 1),
      percentage: tipHeight > 0 ? (synced / (tipHeight + 1)) * 100 : 100,
    };
  }

  /**
   * Wait for header sync to complete (optional)
   */
  async waitForHeaderSync(timeoutMs: number = 300000): Promise<void> {
    if (this.headerSyncComplete) {
      return;
    }

    if (!this.headerSyncPromise) {
      throw new Error('Header sync not initiated');
    }

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Header sync timeout')), timeoutMs);
    });

    await Promise.race([this.headerSyncPromise, timeoutPromise]);
  }
}
