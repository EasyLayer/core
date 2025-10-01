import * as crypto from 'node:crypto';
import type { NetworkConfig as BitcoreNetworkConfig } from 'bitcore-p2p';
import { Pool, Peer, Messages } from 'bitcore-p2p';
import type { BaseTransportOptions } from '../../../core';
import { BaseTransport } from '../../../core';

const isNodeLike = typeof process !== 'undefined' && !!process.versions?.node;

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
 * - requestHexBlocks: results[i] corresponds to hashes[i], null for missing blocks
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
  checkpoint?: { hash: string; height: number };
}

/**
 * Internal chain tracker for P2P transport
 * Maintains height->hash mapping with order guarantees
 */
class ChainTracker {
  private heightToHash: Map<number, string> = new Map();
  private hashToHeight = new Map<string, number>();
  private tipHeight: number = -1;
  private maxHeight?: number;

  constructor(maxHeight?: number) {
    this.maxHeight = maxHeight;
  }

  addHeader(hash: string, height: number): boolean {
    if (this.maxHeight !== undefined && height > this.maxHeight) return false;

    const existingHashAtHeight = this.heightToHash.get(height);
    if (existingHashAtHeight && existingHashAtHeight !== hash) {
      this.handleReorg(height, hash);
      return true;
    }

    this.heightToHash.set(height, hash);
    this.hashToHeight.set(hash, height);
    if (height > this.tipHeight) this.tipHeight = height;
    return true;
  }

  private handleReorg(conflictHeight: number, newHash: string): void {
    for (let h = conflictHeight; h <= this.tipHeight; h++) {
      const oldHash = this.heightToHash.get(h);
      if (oldHash) this.hashToHeight.delete(oldHash);
      this.heightToHash.delete(h);
    }
    this.heightToHash.set(conflictHeight, newHash);
    this.hashToHeight.set(newHash, conflictHeight);
    this.tipHeight = conflictHeight;
  }

  getHeight(hash: string): number | undefined {
    return this.hashToHeight.get(hash);
  }

  getHash(height: number): string | undefined {
    return this.heightToHash.get(height);
  }

  getTipHeight(): number {
    return this.tipHeight;
  }

  getManyHashes(heights: number[]): (string | null)[] {
    return heights.map((height) => this.getHash(height) || null);
  }

  getMappingCount(): number {
    return this.heightToHash.size;
  }

  clear(): void {
    this.heightToHash.clear();
    this.hashToHeight.clear();
    this.tipHeight = -1;
  }
}

type BlockSubscriber = {
  onData: (blockData: Buffer) => void;
  onError?: (err: Error) => void;
};

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

  private blockSubscribers = new Set<BlockSubscriber>();

  private headerSyncPromise: Promise<void> | null = null;

  constructor(options: P2PTransportOptions) {
    super(options);

    if (!isNodeLike) {
      throw new Error('P2PTransport requires Node/Electron main. Use RPCTransport in browser.');
    }

    this.peers = options.peers;
    this.connectionTimeout = options.connectionTimeout ?? 30000;
    this.headerSyncEnabled = options.headerSyncEnabled ?? true;
    this.headerSyncBatchSize = options.headerSyncBatchSize ?? 2000;

    this.chainTracker = new ChainTracker(options.maxHeight);
    if (options.checkpoint) this.chainTracker.addHeader(options.checkpoint.hash, options.checkpoint.height);

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
        const peer = new Peer({ host: peerConfig.host, port: peerConfig.port });
        this.pool.addPeer(peer);
      });

      this.pool.connect();

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('P2P connection timeout')), this.connectionTimeout);
        this.pool.once('peerready', (peer: Peer) => {
          clearTimeout(timeout);
          this.activePeer = peer;
          this.setupPeerEventHandlers(peer);
          this.isConnected = true;
          resolve();
        });
      });

      if (this.headerSyncEnabled) {
        this.headerSyncPromise = this.initializeHeaderSync();
      }
    }, 'connect');
  }

  async disconnect(): Promise<void> {
    await this.rateLimiter.stop();

    this.blockSubscribers.clear();

    this.chainTracker.clear();
    this.headerSyncComplete = false;
    this.headerSyncPromise = null;

    this.pool.disconnect();
    this.activePeer = null;
    this.isConnected = false;
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
  /* eslint-disable no-empty */
  async getManyBlockHashesByHeights(heights: number[]): Promise<(string | null)[]> {
    return this.executeWithErrorHandling(async () => {
      if (!this.headerSyncComplete && this.headerSyncPromise) {
        try {
          await Promise.race([this.headerSyncPromise, new Promise((resolve) => setTimeout(resolve, 5000))]);
        } catch {}
      }
      return this.chainTracker.getManyHashes(heights);
    }, 'getManyBlockHashesByHeights');
  }
  /* eslint-enable no-empty */

  /**
   * ORDER GUARANTEE: results[i] corresponds to hashes[i]
   * Missing/failed items return null at the same index
   */
  async requestHexBlocks(hashes: string[]): Promise<(Buffer | null)[]> {
    return this.executeWithErrorHandling(async () => {
      if (!this.activePeer) return hashes.map(() => null);

      const batchSize = 128;
      const out: (Buffer | null)[] = new Array(hashes.length);
      for (let i = 0; i < hashes.length; i += batchSize) {
        const slice = hashes.slice(i, i + batchSize);
        const got = await this.requestHexBlocksBatch(slice);
        for (let j = 0; j < slice.length; j++) {
          out[i + j] = got[j]!;
        }
      }
      return out;
    }, 'requestHexBlocks');
  }

  /**
   * Get heights by block hashes using local ChainTracker.
   * Time complexity: O(k), each lookup O(1) via hashToHeight map.
   * Returns null for unknown hashes (e.g., headers not synced yet).
   */
  public async getHeightsByHashes(hashes: string[]): Promise<(number | null)[]> {
    return hashes.map((h) => {
      const height = this.chainTracker.getHeight(h);
      return typeof height === 'number' ? height : null;
    });
  }

  /**
   * P2P batch call with null support
   * ORDER GUARANTEE: results[i] corresponds to calls[i]
   */
  async batchCall<TResult = any>(calls: Array<{ method: string; params: any[] }>): Promise<(TResult | null)[]> {
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
          results[i] = null;
        }
      } catch {
        results[i] = null;
      }
    }
    return results;
  }

  // Multiple-subscriber API with error propagation
  subscribeToNewBlocks(
    callback: (blockData: Buffer) => void,
    onError?: (err: Error) => void
  ): { unsubscribe: () => void } {
    const sub: BlockSubscriber = { onData: callback, onError };
    this.blockSubscribers.add(sub);
    return {
      unsubscribe: () => {
        this.blockSubscribers.delete(sub);
      },
    };
  }

  /* eslint-disable no-empty */
  private async initializeHeaderSync(): Promise<void> {
    if (!this.activePeer) throw new Error('No active peer for header sync');
    try {
      await this.syncAllHeadersFromTrustedPeer();
      this.headerSyncComplete = true;
    } catch {}
  }
  /* eslint-enable no-empty */

  private async syncAllHeadersFromTrustedPeer(): Promise<void> {
    if (!this.activePeer) throw new Error('No active peer for header sync');
    while (true) {
      const headers = await this.requestHeadersBatch();
      if (!headers || headers.length === 0) break;
      for (const header of headers) {
        const prevHeight = this.chainTracker.getHeight(header.previousblockhash);
        if (typeof prevHeight === 'number') this.chainTracker.addHeader(header.hash, prevHeight + 1);
      }
      if (headers.length < this.headerSyncBatchSize) break;
    }
  }

  private async requestHeadersBatch(): Promise<Array<{ hash: string; previousblockhash: string }> | null> {
    if (!this.activePeer) throw new Error('No active peer available');

    return new Promise<Array<{ hash: string; previousblockhash: string }> | null>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Header batch request timeout')), 30000);

      const locator = this.buildLocator();
      const getHeadersMessage = new Messages.GetHeaders({ starts: locator, stop: Buffer.alloc(32) });

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

  private buildLocator(): Buffer[] {
    const loc: Buffer[] = [];
    let step = 1;
    for (let h = this.chainTracker.getTipHeight(); h >= 0; h -= step) {
      const hash = this.chainTracker.getHash(h);
      if (hash) loc.push(Buffer.from(hash, 'hex').reverse());
      if (loc.length >= 10) step *= 2;
      if (loc.length >= 32) break;
    }
    if (!loc.length) loc.push(Buffer.alloc(32));
    return loc;
  }

  private parseHeaderBuffer(headerBuffer: Buffer): {
    hash: string;
    previousblockhash: string;
    merkleroot: string;
    time: number;
    bits: string;
    nonce: number;
  } {
    if (headerBuffer.length !== 80) throw new Error(`Invalid header length: ${headerBuffer.length}, expected 80`);
    const previousblockhash = headerBuffer.slice(4, 36).reverse().toString('hex');
    const merkleroot = headerBuffer.slice(36, 68).reverse().toString('hex');
    const time = headerBuffer.readUInt32LE(68);
    const bits = headerBuffer.slice(72, 76).toString('hex');
    const nonce = headerBuffer.readUInt32LE(76);

    const hash1 = crypto.createHash('sha256').update(headerBuffer).digest();
    const hash2 = crypto.createHash('sha256').update(hash1).digest();
    const hash = hash2.reverse().toString('hex');

    return { hash, previousblockhash, merkleroot, time, bits, nonce };
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
      }
    });

    this.pool.on('error', () => {});
  }

  /* eslint-disable no-empty */
  private setupPeerEventHandlers(peer: Peer): void {
    peer.on('block', (message: any) => {
      if (!message?.block?.toBuffer) return;
      const blockBuffer = message.block.toBuffer();

      for (const s of this.blockSubscribers) {
        try {
          s.onData(blockBuffer);
        } catch (err) {
          s.onError?.(err instanceof Error ? err : new Error(String(err)));
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
          }
        }
      } catch {}
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
          } catch {}
        });
      }
    });

    peer.on('ping', (message: any) => {
      if (message?.nonce) peer.sendMessage(new Messages.Pong(message.nonce));
    });
  }
  /* eslint-enable no-empty */

  private requestHexBlocksBatch(hashes: string[]): Promise<(Buffer | null)[]> {
    return new Promise<(Buffer | null)[]>((resolve) => {
      if (!this.activePeer) {
        resolve(hashes.map(() => null));
        return;
      }

      const hashToPosition = new Map<string, number>();
      hashes.forEach((h, idx) => hashToPosition.set(h, idx));

      const expected = new Set(hashes);
      const received = new Map<string, Buffer>();
      const timeoutMs = Math.min(60_000, 10_000 + hashes.length * 300);

      const onBlock = (message: any) => {
        const h = message?.block?.hash?.toString?.('hex');
        if (!h || !expected.has(h)) return;

        const buf = message.block.toBuffer();
        received.set(h, buf);
        expected.delete(h);

        if (expected.size === 0) done();
      };

      const done = () => {
        clearTimeout(timer);
        this.activePeer?.removeListener('block', onBlock);

        const ordered: (Buffer | null)[] = new Array(hashes.length).fill(null);
        for (const [h, buf] of received) {
          const pos = hashToPosition.get(h);
          if (pos !== undefined) ordered[pos] = buf;
        }
        resolve(ordered);
      };

      const timer = setTimeout(() => {
        this.activePeer?.removeListener('block', onBlock);
        done();
      }, timeoutMs);

      this.activePeer.on('block', onBlock);

      try {
        const inventory = hashes.map((h) => ({ type: 2, hash: Buffer.from(h, 'hex').reverse() }));
        const getDataMessage = new Messages.GetData(inventory);
        this.activePeer.sendMessage(getDataMessage);
      } catch {
        clearTimeout(timer);
        this.activePeer?.removeListener('block', onBlock);
        resolve(hashes.map(() => null));
      }
    });
  }

  private extractPreviousBlockHash(blockBuffer: Buffer): string | null {
    try {
      if (blockBuffer.length < 36) return null;
      return blockBuffer.slice(4, 36).reverse().toString('hex');
    } catch {
      return null;
    }
  }
}
