import type { Logger } from '@nestjs/common';
import type { BlockchainProviderService, IncomingRawBlock } from '../../../blockchain-provider';
import type { BlocksLoadingStrategy, Subscription } from './load-strategy.interface';
import { StrategyNames } from './load-strategy.interface';
import type { BlocksQueue } from '../../blocks-queue';
import type { RawBlock } from '../../interfaces';

interface BlockInfo {
  hash: string;
  size: number; // binary total_size
  height: number;
}

/**
 * RpcZmqProviderStrategy — RPC batch catch-up + ZMQ real-time subscription.
 *
 * Two-phase strategy (Node/Electron only):
 * Phase 1 — RPC batch catch-up:
 *   Fetch blocks in batches using reply-size budgeting until caught up.
 *
 * Phase 2 — ZMQ real-time subscription:
 *   Once caught up, subscribe to ZMQ rawblock stream for zero-polling delivery.
 *   On ZMQ disconnect: transport emits onError → strategy rejects → loader
 *   supervisor resets timer → next tick restarts from Phase 1 (catch-up
 *   recovers any blocks missed during the disconnect window).
 *   If zmqEndpoint is not configured: load() returns after catch-up and
 *   falls back to polling at monitoringInterval (same as RpcProviderStrategy).
 *
 * Requires Node.js (zeromq package). Do NOT use in browser context.
 *
 * RPC reply budget:
 *   predictedReplyBytes ≈ sum(block.total_size) × 2.1
 *   ×2.0 hex encoding + ×1.05 JSON-RPC envelope.
 */
export class RpcZmqProviderStrategy implements BlocksLoadingStrategy {
  readonly name: StrategyNames = StrategyNames.RPC_ZMQ;
  private readonly moduleName = 'blocks-queue';

  private _maxRpcReplyBytes: number = 10 * 1024 * 1024;
  private _preloadedItemsQueue: BlockInfo[] = [];
  private readonly _basePreloadCount: number;
  private readonly _maxPreloadCountCap: number;
  private _currentPreloadCount: number;
  private _lastLoadAndEnqueueDuration = 0;

  // Active ZMQ subscription (Phase 2), if any
  private _subscription?: Subscription;

  constructor(
    private readonly logger: Logger,
    private readonly blockchainProvider: BlockchainProviderService,
    private readonly queue: BlocksQueue,
    config: {
      maxRpcReplyBytes: number;
      preloadCount: number;
    }
  ) {
    this._maxRpcReplyBytes = config.maxRpcReplyBytes;
    this._basePreloadCount = Math.max(1, Math.floor(config.preloadCount));
    this._maxPreloadCountCap = Math.max(this._basePreloadCount, this._basePreloadCount * 4);
    this._currentPreloadCount = this._basePreloadCount;
  }

  /**
   * Phase 1: batch RPC pull until caught up to currentNetworkHeight.
   * Phase 2: ZMQ subscription if available, else return (timer polls).
   */
  public async load(currentNetworkHeight: number): Promise<void> {
    const targetHeight = Math.min(currentNetworkHeight, this.queue.maxBlockHeight);

    // Phase 1: RPC batch catch-up
    while (this.queue.lastHeight < targetHeight) {
      if (this.queue.isMaxHeightReached) return;

      if (this.queue.isQueueFull) {
        throw new Error('The queue is full, waiting before retry');
      }

      if (this._preloadedItemsQueue.length === 0) {
        await this.preloadBlocksInfo(targetHeight);

        this.logger.debug('Preloaded block infos for RPC+ZMQ strategy', {
          module: this.moduleName,
          args: { preloadedBlocks: this._preloadedItemsQueue.length },
        });
      }

      if (this.queue.isQueueOverloaded(this._maxRpcReplyBytes)) {
        throw new Error('The queue is overloaded, waiting before retry');
      }

      if (this._preloadedItemsQueue.length === 0) {
        return;
      }

      await this.loadAndEnqueueBlocks();
    }

    // Phase 2: caught up — try ZMQ subscription if not already active
    if (this._subscription) {
      await this._subscription;
      return;
    }

    if (!this.blockchainProvider.hasNetworkProvidersAvailable()) return;

    this.logger.debug('RPC+ZMQ catch-up complete, switching to ZMQ subscription', {
      module: this.moduleName,
      args: { height: this.queue.lastHeight },
    });

    await this.startZMQSubscription();
  }

  public async stop(): Promise<void> {
    this._preloadedItemsQueue = [];

    if (this._subscription) {
      try {
        this._subscription.unsubscribe();
      } catch {
        // ignore cleanup errors
      }
      this._subscription = undefined;
    }

    this.logger.verbose('RPC+ZMQ strategy stopped', { module: this.moduleName });
  }

  // ===== PHASE 2: ZMQ subscription =====

  private async startZMQSubscription(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settledWithError = false;

      this._subscription = this.blockchainProvider.subscribeToNewBlocks(
        async (raw: IncomingRawBlock) => {
          try {
            if (this.queue.isMaxHeightReached) return;

            if (this.queue.isQueueFull) {
              settledWithError = true;
              this._subscription?.unsubscribe();
              reject(new Error('The queue is full'));
              return;
            }

            await this.enqueueLiveBlock(raw);
          } catch (error) {
            this.logger.verbose('RPC+ZMQ strategy: block processing error', {
              module: this.moduleName,
              args: { action: 'zmqBlock', error },
            });
            settledWithError = true;
            this._subscription?.unsubscribe();
            this._subscription = undefined;
            reject(error);
          }
        },
        (subscriptionError) => {
          // ZMQ disconnected — transport already cleared subscriptions and notified us
          this.logger.verbose('RPC+ZMQ strategy: subscription error', {
            module: this.moduleName,
            args: { action: 'zmqError', error: subscriptionError },
          });
          settledWithError = true;
          try {
            this._subscription?.unsubscribe();
          } catch {
            /* ignore */
          }
          this._subscription = undefined;
          reject(subscriptionError);
        }
      );

      this._subscription
        .then(() => {
          this._subscription = undefined;
          if (!settledWithError) {
            this.logger.verbose('RPC+ZMQ subscription completed gracefully', {
              module: this.moduleName,
            });
            resolve();
          }
        })
        .catch((err) => {
          this._subscription = undefined;
          if (!settledWithError) reject(err);
        });
    });
  }

  private async enqueueLiveBlock(raw: IncomingRawBlock): Promise<void> {
    const tipHash = await this.ensureQueueTipHashForLive();
    const expectedHeight = this.queue.lastHeight + 1;

    if (raw.prevHash !== tipHash) {
      throw new Error(
        `RPC+ZMQ strategy: live block continuity mismatch: prevHash=${raw.prevHash}, expectedTipHash=${tipHash}, incomingHash=${raw.hash}, expectedHeight=${expectedHeight}`
      );
    }

    await this.enqueueBlock({
      hash: raw.hash,
      prevHash: raw.prevHash,
      height: expectedHeight,
      size: raw.size,
      bytes: raw.bytes,
    });
  }

  private async ensureQueueTipHashForLive(): Promise<string> {
    if (this.queue.lastHash) return this.queue.lastHash;

    const lastHeight = this.queue.lastHeight;
    if (!Number.isFinite(lastHeight) || lastHeight < 0) {
      throw new Error(`RPC+ZMQ strategy: cannot start live subscription without a known queue height`);
    }

    const tipHash = await this.blockchainProvider.getOneBlockHashByHeight(lastHeight);
    if (!tipHash) {
      throw new Error(`RPC+ZMQ strategy: cannot start live subscription without tip hash for height ${lastHeight}`);
    }

    this.queue.setLastHashForContinuity(tipHash);
    return tipHash;
  }

  private async enqueueBlock(raw: RawBlock): Promise<void> {
    if (raw.height <= this.queue.lastHeight) {
      this.logger.verbose('RPC+ZMQ strategy: skipping block with height ≤ lastHeight', {
        module: this.moduleName,
        args: { blockHeight: raw.height, lastHeight: this.queue.lastHeight },
      });
      return;
    }
    await this.queue.enqueue(raw);
  }

  // ===== PHASE 1: RPC batch catch-up =====

  /**
   * Preload block metadata for the next height window. Initial count is derived
   * from provider rate-limit maxBatchSize. After each preload the next count is
   * tuned from observed block sizes and bounded by basePreloadCount * 4.
   */
  private async preloadBlocksInfo(currentNetworkHeight: number): Promise<void> {
    const lastHeight = this.queue.lastHeight;
    const remaining = currentNetworkHeight - lastHeight;
    const count = Math.min(this._currentPreloadCount, remaining);
    if (count <= 0) return;

    const heights = Array.from({ length: count }, (_, i) => lastHeight + 1 + i);
    const blockInfos = await this.blockchainProvider.getManyBlocksStatsByHeights(heights);
    this.adjustPreloadCountFromBlockInfos(blockInfos);

    for (const { blockhash, total_size, height } of blockInfos) {
      if (!blockhash || height == null) {
        throw new Error('Block infos missing required hash and height');
      }
      const size = total_size != null ? total_size : this.queue.blockSize;
      this._preloadedItemsQueue.push({ hash: blockhash, size, height });
    }
  }

  private adjustPreloadCountFromBlockInfos(blockInfos: Array<{ total_size?: number | null }>): void {
    if (blockInfos.length === 0) return;

    const OVERHEAD = 2.1;
    const totalPredictedReplyBytes = blockInfos.reduce((sum, info) => {
      const rawSize = info.total_size != null ? info.total_size : this.queue.blockSize;
      return sum + Math.max(1, Math.floor(rawSize * OVERHEAD));
    }, 0);
    const averagePredictedReplyBytes = Math.max(1, totalPredictedReplyBytes / blockInfos.length);
    const nextPreloadCount = Math.max(
      1,
      Math.min(this._maxPreloadCountCap, Math.floor(this._maxRpcReplyBytes / averagePredictedReplyBytes))
    );

    if (nextPreloadCount !== this._currentPreloadCount) {
      const previousPreloadCount = this._currentPreloadCount;
      this._currentPreloadCount = nextPreloadCount;
      this.logger.verbose('Adjusted RPC+ZMQ preload count from observed block sizes', {
        module: this.moduleName,
        args: {
          previousPreloadCount,
          nextPreloadCount,
          basePreloadCount: this._basePreloadCount,
          maxPreloadCountCap: this._maxPreloadCountCap,
          maxRpcReplyBytes: this._maxRpcReplyBytes,
          averagePredictedReplyBytes: Math.round(averagePredictedReplyBytes),
          observedBlockInfos: blockInfos.length,
        },
      });
    }
  }

  /**
   * Fill one batch by reply-size budget and fetch+enqueue.
   *
   * ×2.0: getblock verbosity=0 returns hex — each byte = 2 ASCII chars.
   * ×1.05: JSON-RPC envelope overhead (~5% of payload).
   * Total: ~2.1× binary block size ≈ expected RPC reply size in bytes.
   */
  private async loadAndEnqueueBlocks(): Promise<void> {
    const retryLimit = 3;
    const startTime = Date.now();
    const OVERHEAD = 2.1;

    const infos: BlockInfo[] = [];
    let predictedReplyBytes = 0;

    this._preloadedItemsQueue.sort((a, b) => {
      if (a.height < b.height) return 1;
      if (a.height > b.height) return -1;
      return 0;
    });

    while (this._preloadedItemsQueue.length > 0) {
      const next = this._preloadedItemsQueue[this._preloadedItemsQueue.length - 1]!;
      const nextPredicted = predictedReplyBytes + Math.floor(next.size * OVERHEAD);
      if (nextPredicted > this._maxRpcReplyBytes) break;
      const info = this._preloadedItemsQueue.pop()!;
      infos.push(info);
      predictedReplyBytes = nextPredicted;
    }

    if (infos.length === 0 && this._preloadedItemsQueue.length > 0) {
      infos.push(this._preloadedItemsQueue.pop()!);
    }

    if (infos.length === 0) return;

    const blocks: RawBlock[] = await this.loadBlocks(infos, retryLimit);

    this.logger.debug('Loaded RPC+ZMQ block batch', {
      module: this.moduleName,
      args: { totalBlocks: blocks.length, totalInfosPulled: infos.length },
    });

    await this.enqueueBlocks(blocks);
    blocks.length = 0;

    this._lastLoadAndEnqueueDuration = Date.now() - startTime;
  }

  private async loadBlocks(infos: BlockInfo[], maxRetries: number): Promise<RawBlock[]> {
    let attempt = 0;
    while (attempt < maxRetries) {
      try {
        const rawFetchStartedAt = Date.now();
        const fetched = await this.blockchainProvider.getManyBlocksRawByKnownHashes(infos);
        const rawFetchMs = Date.now() - rawFetchStartedAt;
        if (!Array.isArray(fetched)) {
          throw new Error('getManyBlocksRawByKnownHashes must return an array of raw blocks');
        }

        const missing = fetched
          .map((block, index) => (block ? null : infos[index]))
          .filter((item): item is BlockInfo => item != null);

        if (missing.length > 0) {
          throw new Error(
            `RPC+ZMQ raw fetch returned missing blocks for known hashes: ${missing
              .map((item) => `${item.height}:${item.hash}`)
              .join(', ')}`
          );
        }

        const blocks = fetched as RawBlock[];
        this.logger.verbose('Loaded RPC+ZMQ raw blocks by known hashes', {
          module: this.moduleName,
          args: {
            phase: 'rpc_zmq_raw_fetch_by_known_hash',
            phaseDurationMs: rawFetchMs,
            requestedBlocks: infos.length,
            loadedBlocks: blocks.length,
            startHeight: infos[0]?.height,
            endHeight: infos[infos.length - 1]?.height,
            predictedReplyBytes: infos.reduce((sum, item) => sum + Math.floor(item.size * 2.1), 0),
            rawBytes: blocks.reduce((sum, block) => sum + block.size, 0),
          },
        });
        return blocks;
      } catch (error) {
        attempt++;
        if (attempt >= maxRetries) {
          this.logger.verbose('Exceeded max retries for fetching blocks batch', {
            module: this.moduleName,
            args: { batchLength: infos.length, error, action: 'loadBlocks' },
          });
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    throw new Error('Failed to fetch blocks batch after maximum retries.');
  }

  private async enqueueBlocks(blocks: RawBlock[]): Promise<void> {
    blocks.sort((a, b) => {
      if (a.height < b.height) return 1;
      if (a.height > b.height) return -1;
      return 0;
    });

    while (blocks.length > 0) {
      const block = blocks.pop();
      if (!block) continue;

      if (block.height <= this.queue.lastHeight) {
        this.logger.verbose('Skipping block with height ≤ lastHeight', {
          module: this.moduleName,
          args: { blockHeight: block.height, lastHeight: this.queue.lastHeight },
        });
        continue;
      }

      await this.queue.enqueue(block);
    }
  }
}
