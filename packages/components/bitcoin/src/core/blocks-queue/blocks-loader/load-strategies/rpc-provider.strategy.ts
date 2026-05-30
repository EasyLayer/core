import type { Logger } from '@nestjs/common';
import type { BlockchainProviderService } from '../../../blockchain-provider';
import type { BlocksLoadingStrategy } from './load-strategy.interface';
import { StrategyNames } from './load-strategy.interface';
import type { BlocksQueue } from '../../blocks-queue';
import type { RawBlock } from '../../interfaces';

interface BlockInfo {
  hash: string;
  size: number; // binary total_size
  height: number;
}

/**
 * RpcProviderStrategy — pure RPC batch pull, no real-time subscription.
 *
 * Single-phase strategy:
 *   Fetch blocks in batches using reply-size budgeting until queue reaches
 *   currentNetworkHeight, then return. The loader's exponential timer calls
 *   load() again at monitoringInterval for continuous polling.
 *
 * Use when:
 *   - Running in a browser context (no ZMQ, no TCP P2P available)
 *   - ZMQ endpoint is not configured
 *   - Simple polling mode is preferred over persistent connection
 *
 * RPC reply budget:
 *   predictedReplyBytes ≈ sum(block.total_size) × 2.1
 *   ×2.0 hex encoding + ×1.05 JSON-RPC envelope.
 */
export class RpcProviderStrategy implements BlocksLoadingStrategy {
  readonly name: StrategyNames = StrategyNames.RPC;
  private readonly moduleName = 'blocks-queue';

  private _maxRpcReplyBytes: number = 10 * 1024 * 1024;
  private _preloadedItemsQueue: BlockInfo[] = [];
  private readonly _basePreloadCount: number;
  private readonly _maxPreloadCountCap: number;
  private _currentPreloadCount: number;
  /**
   * When true, heavy-block ranges bypass getblockstats preload and fetch raw blocks by height.
   * This avoids doing getblockhash + getblockstats + getblock for every 1-3 large blocks.
   */
  private _directRawMode = false;
  private _directRawFetchCount: number;
  /**
   * Hysteresis threshold for leaving direct-raw mode. Metadata preload should
   * return only when the observed raw-block window can grow well beyond the
   * provider max batch size. Otherwise large-block ranges can oscillate between
   * one metadata preload and one direct-raw window, causing repeated extra
   * getblockstats calls on every loader cycle.
   */
  private readonly _metadataReenablePreloadCount: number;

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
    this._directRawFetchCount = this._basePreloadCount;
    this._metadataReenablePreloadCount = Math.min(this._maxPreloadCountCap, this._basePreloadCount * 2);
  }

  /**
   * Batch RPC pull until queue catches up to currentNetworkHeight, then return.
   * The exponential timer handles re-invocation for continuous polling.
   */
  public async load(currentNetworkHeight: number): Promise<void> {
    const targetHeight = Math.min(currentNetworkHeight, this.queue.maxBlockHeight);

    while (this.queue.lastHeight < targetHeight) {
      if (this.queue.isMaxHeightReached) return;

      if (this.queue.isQueueFull) {
        throw new Error('The queue is full, waiting before retry');
      }

      if (this._preloadedItemsQueue.length === 0) {
        if (this._directRawMode) {
          await this.loadRawHeightWindow(targetHeight);
          continue;
        }

        await this.preloadBlocksInfo(targetHeight);

        this.logger.debug('Preloaded block infos for RPC strategy', {
          module: this.moduleName,
          args: { preloadedBlocks: this._preloadedItemsQueue.length },
        });

        if (this._directRawMode && this._preloadedItemsQueue.length === 0) {
          continue;
        }
      }

      if (this.queue.isQueueOverloaded(this._maxRpcReplyBytes)) {
        throw new Error('The queue is overloaded, waiting before retry');
      }

      if (this._preloadedItemsQueue.length === 0) {
        return;
      }

      await this.loadAndEnqueueBlocks();
    }
    // Caught up — return so loader timer polls again at monitoringInterval
  }

  public async stop(): Promise<void> {
    this._preloadedItemsQueue = [];
    this._directRawMode = false;
    this._directRawFetchCount = this._basePreloadCount;
    this.logger.verbose('RPC strategy stopped', { module: this.moduleName });
  }

  // ===== INTERNALS =====

  /**
   * Preload block metadata for the next height window.
   *
   * Initial count is derived from the provider rate-limit maxBatchSize, so one
   * preload normally maps to one JSON-RPC batch per metadata method. After each
   * successful preload we tune the next count from the observed average block
   * size and the raw RPC reply byte budget:
   *   - large blocks reduce the next preload count toward 1-3 heights;
   *   - small blocks can increase it, but only up to basePreloadCount * 4.
   *
   * This preserves the useful dynamic behavior without allowing preload to grow
   * unbounded to values such as 100 and accidentally span many rate-limited
   * HTTP JSON-RPC batches.
   */
  private async preloadBlocksInfo(currentNetworkHeight: number): Promise<void> {
    const lastHeight = this.queue.lastHeight;
    const remaining = currentNetworkHeight - lastHeight;
    const count = Math.min(this._currentPreloadCount, remaining);
    if (count <= 0) return;

    const heights = Array.from({ length: count }, (_, i) => lastHeight + 1 + i);
    const preloadStartedAt = Date.now();
    const blockInfos = await this.blockchainProvider.getManyBlocksStatsByHeights(heights);
    const preloadDurationMs = Date.now() - preloadStartedAt;

    if (blockInfos.length === 0) {
      const message =
        `RPC preload returned zero valid block stats for requested heights ${heights[0]}-${heights[heights.length - 1]} ` +
        `(requested=${heights.length}, currentNetworkHeight=${currentNetworkHeight}, lastQueueHeight=${lastHeight}). ` +
        `This usually means getblockhash/getblockstats returned only nulls/errors or the RPC provider rejected the batch. ` +
        `Check preceding blockchain-provider/RPC transport diagnostics for null/error counts.`;

      this.logger.warn(message, {
        module: this.moduleName,
        args: {
          action: 'preloadBlocksInfo',
          requestedHeights: heights.length,
          firstHeight: heights[0],
          lastHeight: heights[heights.length - 1],
          currentNetworkHeight,
          queueLastHeight: lastHeight,
          currentPreloadCount: this._currentPreloadCount,
          basePreloadCount: this._basePreloadCount,
          maxPreloadCountCap: this._maxPreloadCountCap,
          phaseDurationMs: preloadDurationMs,
        },
      });

      throw new Error(message);
    }

    this.logger.debug('Preloaded RPC block stats for strategy', {
      module: this.moduleName,
      args: {
        action: 'preloadBlocksInfo',
        requestedHeights: heights.length,
        validBlockInfos: blockInfos.length,
        firstRequestedHeight: heights[0],
        lastRequestedHeight: heights[heights.length - 1],
        firstValidHeight: blockInfos[0]?.height,
        lastValidHeight: blockInfos[blockInfos.length - 1]?.height,
        phaseDurationMs: preloadDurationMs,
        currentPreloadCount: this._currentPreloadCount,
      },
    });

    this.adjustPreloadCountFromBlockInfos(blockInfos);

    if (this._directRawMode) {
      return;
    }

    for (const { blockhash, total_size, height } of blockInfos) {
      if (!blockhash || height == null) {
        throw new Error(
          `Block infos missing required hash and height while preloading RPC blocks: ` +
            `height=${String(height)}, blockhash=${String(blockhash)}`
        );
      }
      const size = total_size != null ? total_size : this.queue.blockSize;
      this._preloadedItemsQueue.push({ hash: blockhash, size, height });
    }
  }

  private adjustPreloadCountFromBlockInfos(blockInfos: Array<{ total_size?: number | null }>): void {
    if (blockInfos.length === 0) return;

    const averagePredictedReplyBytes = this.averagePredictedReplyBytesFromSizes(
      blockInfos.map((info) => (info.total_size != null ? info.total_size : this.queue.blockSize))
    );
    const nextByBudget = this.nextCountForPredictedReplyBytes(averagePredictedReplyBytes);

    // If the next useful raw block window is smaller than the provider batch
    // size, metadata preload becomes counterproductive: it adds getblockstats
    // calls only to discover that raw fetch will still load 1-3 blocks. Switch
    // to direct height->raw fetch until actual raw block sizes indicate that the
    // window can grow back to the provider batch size.
    if (nextByBudget < this._basePreloadCount) {
      const previousMode = this._directRawMode ? 'direct-raw' : 'metadata-preload';
      this._directRawMode = true;
      this._directRawFetchCount = nextByBudget;
      this._preloadedItemsQueue = [];
      this.logger.verbose('RPC metadata preload disabled for heavy block range', {
        module: this.moduleName,
        args: {
          previousMode,
          nextMode: 'direct-raw',
          directRawFetchCount: this._directRawFetchCount,
          basePreloadCount: this._basePreloadCount,
          metadataReenablePreloadCount: this._metadataReenablePreloadCount,
          maxRpcReplyBytes: this._maxRpcReplyBytes,
          averagePredictedReplyBytes: Math.round(averagePredictedReplyBytes),
          observedBlockInfos: blockInfos.length,
        },
      });
      return;
    }

    const nextPreloadCount = Math.min(this._maxPreloadCountCap, nextByBudget);
    const changed = this._directRawMode || nextPreloadCount !== this._currentPreloadCount;
    const previousPreloadCount = this._currentPreloadCount;
    this._directRawMode = false;
    this._currentPreloadCount = nextPreloadCount;
    this._directRawFetchCount = nextPreloadCount;

    if (changed) {
      this.logger.verbose('Adjusted RPC preload count from observed block sizes', {
        module: this.moduleName,
        args: {
          previousPreloadCount,
          nextPreloadCount,
          basePreloadCount: this._basePreloadCount,
          maxPreloadCountCap: this._maxPreloadCountCap,
          maxRpcReplyBytes: this._maxRpcReplyBytes,
          averagePredictedReplyBytes: Math.round(averagePredictedReplyBytes),
          observedBlockInfos: blockInfos.length,
          mode: 'metadata-preload',
        },
      });
    }
  }

  private averagePredictedReplyBytesFromSizes(sizes: number[]): number {
    const OVERHEAD = 2.1;
    if (sizes.length === 0) return Math.max(1, this.queue.blockSize * OVERHEAD);
    const totalPredictedReplyBytes = sizes.reduce((sum, size) => {
      return sum + Math.max(1, Math.floor((size || this.queue.blockSize) * OVERHEAD));
    }, 0);
    return Math.max(1, totalPredictedReplyBytes / sizes.length);
  }

  private nextCountForPredictedReplyBytes(averagePredictedReplyBytes: number): number {
    return Math.max(1, Math.floor(this._maxRpcReplyBytes / Math.max(1, averagePredictedReplyBytes)));
  }

  private adjustDirectRawFetchCountFromBlocks(blocks: RawBlock[]): void {
    if (blocks.length === 0) return;

    const averagePredictedReplyBytes = this.averagePredictedReplyBytesFromSizes(blocks.map((block) => block.size));
    const nextByBudget = this.nextCountForPredictedReplyBytes(averagePredictedReplyBytes);

    if (nextByBudget >= this._metadataReenablePreloadCount) {
      const nextPreloadCount = Math.min(this._maxPreloadCountCap, nextByBudget);
      this._directRawMode = false;
      this._currentPreloadCount = nextPreloadCount;
      this._directRawFetchCount = nextPreloadCount;
      this.logger.verbose('RPC metadata preload re-enabled after observing a large raw fetch window', {
        module: this.moduleName,
        args: {
          nextPreloadCount,
          basePreloadCount: this._basePreloadCount,
          metadataReenablePreloadCount: this._metadataReenablePreloadCount,
          maxRpcReplyBytes: this._maxRpcReplyBytes,
          averagePredictedReplyBytes: Math.round(averagePredictedReplyBytes),
          observedBlocks: blocks.length,
        },
      });
      return;
    }

    const nextDirectRawFetchCount = nextByBudget;
    if (nextDirectRawFetchCount !== this._directRawFetchCount) {
      const previousDirectRawFetchCount = this._directRawFetchCount;
      this._directRawFetchCount = nextDirectRawFetchCount;
      this.logger.verbose('Adjusted RPC direct raw fetch count from observed raw blocks', {
        module: this.moduleName,
        args: {
          previousDirectRawFetchCount,
          nextDirectRawFetchCount,
          basePreloadCount: this._basePreloadCount,
          maxRpcReplyBytes: this._maxRpcReplyBytes,
          averagePredictedReplyBytes: Math.round(averagePredictedReplyBytes),
          observedBlocks: blocks.length,
        },
      });
    }
  }

  private async loadRawHeightWindow(currentNetworkHeight: number): Promise<void> {
    const lastHeight = this.queue.lastHeight;
    const remaining = currentNetworkHeight - lastHeight;
    const count = Math.max(1, Math.min(this._directRawFetchCount, remaining));
    const heights = Array.from({ length: count }, (_item, index) => lastHeight + 1 + index);
    if (!heights.length) return;

    const startTime = Date.now();
    const blocks = await this.loadBlocksByHeights(heights, 3);
    this.adjustDirectRawFetchCountFromBlocks(blocks);

    this.logger.debug('Loaded RPC direct raw block height window', {
      module: this.moduleName,
      args: {
        totalBlocks: blocks.length,
        requestedHeights: heights.length,
        firstHeight: heights[0],
        lastHeight: heights[heights.length - 1],
        phaseDurationMs: Date.now() - startTime,
        directRawFetchCount: this._directRawFetchCount,
      },
    });

    await this.enqueueBlocks(blocks);
    blocks.length = 0;
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

    this.logger.debug('Loaded RPC block batch', {
      module: this.moduleName,
      args: { totalBlocks: blocks.length, totalInfosPulled: infos.length },
    });

    const loadedBlocks = blocks.length;
    await this.enqueueBlocks(blocks);
    blocks.length = 0;

    const loadAndEnqueueDuration = Date.now() - startTime;
    this.logger.verbose('RPC load/enqueue batch completed', {
      module: this.moduleName,
      args: {
        phase: 'rpc_load_and_enqueue',
        phaseDurationMs: loadAndEnqueueDuration,
        pulledInfos: infos.length,
        loadedBlocks,
      },
    });
  }

  private async loadBlocks(infos: BlockInfo[], maxRetries: number): Promise<RawBlock[]> {
    let attempt = 0;
    while (attempt < maxRetries) {
      try {
        const rawFetchStartedAt = Date.now();
        const raw = await this.blockchainProvider.getManyBlocksRawByKnownHashes(infos);
        const rawFetchMs = Date.now() - rawFetchStartedAt;
        if (!Array.isArray(raw)) {
          throw new Error('getManyBlocksRawByKnownHashes must return an array of raw blocks');
        }
        const missing = raw
          .map((block, index) => (block ? null : infos[index]))
          .filter((item): item is BlockInfo => item != null);

        if (missing.length > 0) {
          throw new Error(
            `RPC raw fetch returned missing blocks for known hashes: ${missing
              .map((item) => `${item.height}:${item.hash}`)
              .join(', ')}`
          );
        }

        const blocks = raw as RawBlock[];
        this.logger.verbose('Loaded RPC raw blocks by known hashes', {
          module: this.moduleName,
          args: {
            phase: 'rpc_raw_fetch_by_known_hash',
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

  private async loadBlocksByHeights(heights: number[], maxRetries: number): Promise<RawBlock[]> {
    let attempt = 0;
    while (attempt < maxRetries) {
      try {
        const rawFetchStartedAt = Date.now();
        const raw = await this.blockchainProvider.getManyBlocksRawByHeights(heights);
        const rawFetchMs = Date.now() - rawFetchStartedAt;
        if (!Array.isArray(raw)) {
          throw new Error('getManyBlocksRawByHeights must return an array of raw blocks');
        }

        const missing = raw
          .map((block, index) => (block ? null : heights[index]))
          .filter((height): height is number => height != null);

        if (missing.length > 0) {
          throw new Error(`RPC direct raw fetch returned missing blocks for heights: ${missing.join(', ')}`);
        }

        const blocks = raw as RawBlock[];
        this.logger.verbose('Loaded RPC raw blocks by heights', {
          module: this.moduleName,
          args: {
            phase: 'rpc_raw_fetch_by_heights',
            phaseDurationMs: rawFetchMs,
            requestedBlocks: heights.length,
            loadedBlocks: blocks.length,
            startHeight: heights[0],
            endHeight: heights[heights.length - 1],
            rawBytes: blocks.reduce((sum, block) => sum + block.size, 0),
          },
        });
        return blocks;
      } catch (error) {
        attempt++;
        if (attempt >= maxRetries) {
          this.logger.verbose('Exceeded max retries for fetching direct raw block height window', {
            module: this.moduleName,
            args: { heights, error, action: 'loadBlocksByHeights' },
          });
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    throw new Error('Failed to fetch direct raw block height window after maximum retries.');
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
