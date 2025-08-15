import type { NetworkConfig as BitcoreNetworkConfig } from 'bitcore-p2p';
import { Pool, Peer, Messages } from 'bitcore-p2p';
import type { BaseTransportOptions } from './base.transport';
import { BaseTransport } from './base.transport';

/**
 * P2P Transport with guaranteed request-response order via position mapping
 *
 * Core Architecture:
 * 1. ChainTracker maintains height->hash mapping from header sync
 * 2. Block requests use hash-to-position mapping for order guarantee
 * 3. No ID-based matching like RPC - relies on explicit position tracking
 * 4. Missing blocks handled gracefully with null values where appropriate
 *
 * Order Guarantees:
 * - getManyBlockHashesByHeights: results[i] corresponds to heights[i], null for missing
 * - requestHexBlocks: results[i] corresponds to hashes[i], throws on missing blocks
 * - ChainTracker.getManyHashes: uses map() to preserve input order
 *
 * Memory usage: ~72 bytes per block for height->hash mapping
 * For 870,000 blocks ≈ 60 MB of memory
 */

export interface P2PTransportOptions extends BaseTransportOptions {
  peers: Array<{ host: string; port: number }>;
  maxPeers?: number;
  connectionTimeout?: number;
  maxHeight?: number;
  headerSyncEnabled?: boolean;
  headerSyncBatchSize?: number;
}

/**
 * Internal chain tracker for P2P transport
 * Maintains height->hash mapping with order guarantees
 */
class ChainTracker {
  private heightToHash: Map<number, string> = new Map();
  private tipHeight: number = -1;
  private maxHeight?: number;

  constructor(maxHeight?: number) {
    this.maxHeight = maxHeight;
  }

  addHeader(hash: string, height: number): boolean {
    if (this.maxHeight !== undefined && height > this.maxHeight) {
      return false;
    }

    const existingHashAtHeight = this.heightToHash.get(height);
    if (existingHashAtHeight && existingHashAtHeight !== hash) {
      this.handleReorg(height, hash);
      return true;
    }

    this.heightToHash.set(height, hash);
    if (height > this.tipHeight) {
      this.tipHeight = height;
    }

    return true;
  }

  private handleReorg(conflictHeight: number, newHash: string): void {
    for (let h = conflictHeight; h <= this.tipHeight; h++) {
      this.heightToHash.delete(h);
    }
    this.heightToHash.set(conflictHeight, newHash);
    this.tipHeight = conflictHeight;
  }

  getHeight(hash: string): number | undefined {
    for (const [height, storedHash] of this.heightToHash) {
      if (storedHash === hash) {
        return height;
      }
    }
    return undefined;
  }

  getHash(height: number): string | undefined {
    return this.heightToHash.get(height);
  }

  getTipHeight(): number {
    return this.tipHeight;
  }

  hasHeight(height: number): boolean {
    return this.heightToHash.has(height);
  }

  /**
   * ORDER GUARANTEE: uses map() to preserve input order
   * Missing heights return null at correct position
   */
  getManyHashes(heights: number[]): (string | null)[] {
    return heights.map((height) => this.getHash(height) || null);
  }

  getMappingCount(): number {
    return this.heightToHash.size;
  }

  clear(): void {
    this.heightToHash.clear();
    this.tipHeight = -1;
  }

  getSyncProgress(currentTipHeight: number): number {
    if (currentTipHeight === 0) return 100;
    return Math.min(100, (this.tipHeight / currentTipHeight) * 100);
  }
}

export class P2PTransport extends BaseTransport<P2PTransportOptions> {
  readonly type = 'p2p';

  private pool: Pool;
  private activePeer: Peer | null = null;
  private peers: Array<{ host: string; port: number }>;
  private connectionTimeout: number;
  private headerSyncEnabled: boolean;
  private headerSyncBatchSize: number;

  private chainTracker: ChainTracker;
  private headerSyncComplete = false;
  private blockSubscriptionCallback: ((blockData: Buffer) => void) | null = null;
  private pendingRequests = new Map<
    string,
    { resolve: (data: any) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }
  >();
  private headerSyncPromise: Promise<void> | null = null;

  constructor(options: P2PTransportOptions) {
    super(options);

    this.peers = options.peers;
    this.connectionTimeout = options.connectionTimeout ?? 30000;
    this.headerSyncEnabled = options.headerSyncEnabled ?? true;
    this.headerSyncBatchSize = options.headerSyncBatchSize ?? 2000;

    this.chainTracker = new ChainTracker(options.maxHeight);

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
      headerSyncEnabled: this.headerSyncEnabled,
      headerSyncBatchSize: this.headerSyncBatchSize,
    };
  }

  async connect(): Promise<void> {
    return this.executeWithErrorHandling(async () => {
      this.peers.forEach((peerConfig) => {
        const peer = new Peer({
          host: peerConfig.host,
          port: peerConfig.port,
        });
        this.pool.addPeer(peer);
      });

      this.pool.connect();

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

      if (this.headerSyncEnabled) {
        this.headerSyncPromise = this.initializeHeaderSync();
      }
    }, 'connect');
  }

  async healthcheck(): Promise<boolean> {
    return this.isConnected && this.activePeer !== null;
  }

  /**
   * Get current blockchain height - throws if not available
   */
  async getBlockHeight(): Promise<number> {
    return this.executeWithErrorHandling(async () => {
      const tipHeight = this.chainTracker.getTipHeight();
      if (tipHeight < 0) {
        throw new Error('Block height not available - header sync not complete');
      }
      return tipHeight;
    }, 'getBlockHeight');
  }

  /**
   * ORDER GUARANTEE: results[i] corresponds to heights[i]
   * Uses ChainTracker.getManyHashes which preserves order via map()
   */
  async getManyBlockHashesByHeights(heights: number[]): Promise<(string | null)[]> {
    return this.executeWithErrorHandling(async () => {
      if (!this.headerSyncComplete && this.headerSyncPromise) {
        try {
          await Promise.race([this.headerSyncPromise, new Promise((resolve) => setTimeout(resolve, 5000))]);
        } catch {
          // Continue with partial data
        }
      }

      // ChainTracker guarantees order preservation
      return this.chainTracker.getManyHashes(heights);
    }, 'getManyBlockHashesByHeights');
  }

  /**
   * ORDER GUARANTEE: results[i] corresponds to hashes[i]
   * Uses hash-to-position mapping to rebuild correct order
   */
  async requestHexBlocks(hashes: string[]): Promise<Buffer[]> {
    return this.executeWithErrorHandling(async () => {
      if (!this.activePeer) {
        throw new Error('No active peer connection');
      }

      return new Promise<Buffer[]>((resolve, reject) => {
        // Create hash-to-position mapping for order guarantee
        const hashToPosition = new Map<string, number>();
        hashes.forEach((hash, index) => {
          hashToPosition.set(hash, index);
        });

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

            // ORDER GUARANTEE: rebuild array in original hash order
            const orderedResults: Buffer[] = new Array(hashes.length);

            for (const [hash, buffer] of receivedBlocks) {
              const position = hashToPosition.get(hash);
              if (position !== undefined) {
                orderedResults[position] = buffer;
              }
            }

            // Validate all positions filled (P2P doesn't tolerate missing blocks)
            for (let i = 0; i < orderedResults.length; i++) {
              if (!orderedResults[i]) {
                reject(new Error(`Missing block at position ${i} for hash ${hashes[i]}`));
                return;
              }
            }

            resolve(orderedResults);
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
    }, 'requestHexBlocks');
  }

  /**
   * P2P batch call with null support
   * ORDER GUARANTEE: results[i] corresponds to calls[i]
   */
  async batchCall<TResult = any>(calls: Array<{ method: string; params: any[] }>): Promise<(TResult | null)[]> {
    // Pre-allocate results array to maintain order
    const results: (TResult | null)[] = new Array(calls.length);

    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      if (!call) {
        results[i] = null;
        continue;
      }

      try {
        if (call.method === 'getblockhash' && typeof call.params?.[0] === 'number') {
          const height = call.params[0];
          const hash = this.chainTracker.getHash(height);
          results[i] = (hash || null) as TResult | null;
        } else if (call.method === 'getblockcount') {
          const tipHeight = this.chainTracker.getTipHeight();
          results[i] = (tipHeight >= 0 ? tipHeight : null) as TResult | null;
        } else {
          throw new Error(`Unsupported P2P method: ${call.method}`);
        }
      } catch (error) {
        // Store null for failed calls to preserve array structure
        results[i] = null;
      }
    }

    return results;
  }

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

    for (const [key, request] of this.pendingRequests) {
      clearTimeout(request.timeout);
      request.reject(new Error('Transport disconnecting'));
    }
    this.pendingRequests.clear();
    this.blockSubscriptionCallback = null;

    this.chainTracker.clear();
    this.headerSyncComplete = false;
    this.headerSyncPromise = null;

    this.pool.disconnect();
    this.activePeer = null;
    this.isConnected = false;
  }

  // Private methods remain the same...
  private async initializeHeaderSync(): Promise<void> {
    if (!this.activePeer) {
      throw new Error('No active peer for header sync');
    }

    try {
      await this.syncAllHeadersFromTrustedPeer();
      this.headerSyncComplete = true;
    } catch (error) {
      // Header sync failed, transport should still work without it
    }
  }

  private async syncAllHeadersFromTrustedPeer(): Promise<void> {
    if (!this.activePeer) {
      throw new Error('No active peer for header sync');
    }

    let currentHeight = 0;

    while (true) {
      try {
        const headers = await this.requestHeadersBatch();

        if (!headers || headers.length === 0) {
          break;
        }

        for (let i = 0; i < headers.length; i++) {
          const header = headers[i];
          if (!header) continue;

          const height = currentHeight + i;

          if (this.chainTracker['maxHeight'] !== undefined && height > this.chainTracker['maxHeight']) {
            return;
          }

          this.chainTracker.addHeader(header.hash, height);
        }

        currentHeight += headers.length;

        if (headers.length < 2000) {
          break;
        }
      } catch (error) {
        break;
      }
    }
  }

  private async requestHeadersBatch(): Promise<Array<{ hash: string; previousblockhash: string }> | null> {
    if (!this.activePeer) {
      throw new Error('No active peer available');
    }

    return new Promise<Array<{ hash: string; previousblockhash: string }> | null>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Header batch request timeout'));
      }, 30000);

      const locator = this.buildSimpleLocator();
      const getHeadersMessage = new Messages.GetHeaders({
        starts: locator,
        stop: Buffer.alloc(32),
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

  private buildSimpleLocator(): Buffer[] {
    const tipHeight = this.chainTracker.getTipHeight();

    if (tipHeight < 0) {
      return [];
    }

    const tipHash = this.chainTracker.getHash(tipHeight);
    if (tipHash) {
      return [Buffer.from(tipHash, 'hex').reverse()];
    }

    return [];
  }

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

    const previousblockhash = headerBuffer.slice(4, 36).reverse().toString('hex');
    const merkleroot = headerBuffer.slice(36, 68).reverse().toString('hex');
    const time = headerBuffer.readUInt32LE(68);
    const bits = headerBuffer.slice(72, 76).toString('hex');
    const nonce = headerBuffer.readUInt32LE(76);

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
    peer.on('block', (message: any) => {
      if (!message?.block?.toBuffer) return;

      const blockBuffer = message.block.toBuffer();

      if (this.blockSubscriptionCallback) {
        try {
          this.blockSubscriptionCallback(blockBuffer);
        } catch (error) {
          // Ignore subscriber callback errors
        }
      }

      try {
        const blockHash = message.block.hash?.toString('hex');
        if (blockHash) {
          const prevHash = this.extractPreviousBlockHash(blockBuffer);
          const prevHeight = prevHash ? this.chainTracker.getHeight(prevHash) : undefined;

          if (prevHeight !== undefined) {
            const newHeight = prevHeight + 1;
            this.chainTracker.addHeader(blockHash, newHeight);
          } else {
            this.tryToAddBlockWithCalculatedHeight(blockHash, blockBuffer);
          }
        }
      } catch (error) {
        // Ignore chain tracking errors for live blocks
      }
    });

    peer.on('headers', (message: any) => {
      if (message?.headers) {
        message.headers.forEach((headerBuffer: Buffer) => {
          try {
            const header = this.parseHeaderBuffer(headerBuffer);
            const prevHeight = this.chainTracker.getHeight(header.previousblockhash);
            if (prevHeight !== undefined) {
              const height = prevHeight + 1;
              this.chainTracker.addHeader(header.hash, height);
            }
          } catch (error) {
            // Ignore header processing errors
          }
        });
      }
    });

    peer.on('ping', (message: any) => {
      if (message?.nonce) {
        peer.sendMessage(new Messages.Pong(message.nonce));
      }
    });
  }

  private tryToAddBlockWithCalculatedHeight(blockHash: string, blockBuffer: Buffer): void {
    try {
      const timestamp = blockBuffer.readUInt32LE(68);
      const currentTime = Math.floor(Date.now() / 1000);

      if (timestamp > 0 && timestamp <= currentTime) {
        const currentTip = this.chainTracker.getTipHeight();
        if (currentTip >= 0) {
          const estimatedHeight = currentTip + 1;
          this.chainTracker.addHeader(blockHash, estimatedHeight);
        }
      }
    } catch {
      // Ignore estimation errors
    }
  }

  private extractPreviousBlockHash(blockBuffer: Buffer): string | null {
    try {
      if (blockBuffer.length < 36) return null;
      return blockBuffer.slice(4, 36).reverse().toString('hex');
    } catch {
      return null;
    }
  }

  isHeaderSyncComplete(): boolean {
    return this.headerSyncComplete;
  }

  async getHeaderSyncProgress(): Promise<{ synced: number; total: number; percentage: number }> {
    const synced = this.chainTracker.getMappingCount();
    const tipHeight = this.chainTracker.getTipHeight();

    return {
      synced,
      total: Math.max(synced, tipHeight + 1),
      percentage: tipHeight > 0 ? (synced / (tipHeight + 1)) * 100 : 100,
    };
  }

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
