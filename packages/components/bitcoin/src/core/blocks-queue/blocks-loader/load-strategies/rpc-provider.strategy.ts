import type { Logger } from '@nestjs/common';
import type { BlockchainProviderService, Block } from '../../../blockchain-provider';
import type { BlocksLoadingStrategy } from './load-strategy.interface';
import { StrategyNames } from './load-strategy.interface';
import type { BlocksQueue } from '../../blocks-queue';

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
  private _maxPreloadCount: number;
  private _lastLoadAndEnqueueDuration = 0;
  private _previousLoadAndEnqueueDuration = 0;

  constructor(
    private readonly logger: Logger,
    private readonly blockchainProvider: BlockchainProviderService,
    private readonly queue: BlocksQueue<Block>,
    config: {
      maxRpcReplyBytes: number;
      basePreloadCount: number;
    }
  ) {
    this._maxRpcReplyBytes = config.maxRpcReplyBytes;
    this._maxPreloadCount = config.basePreloadCount;
  }

  /**
   * Batch RPC pull until queue catches up to currentNetworkHeight, then return.
   * The exponential timer handles re-invocation for continuous polling.
   */
  public async load(currentNetworkHeight: number): Promise<void> {
    while (this.queue.lastHeight < currentNetworkHeight) {
      if (this.queue.isMaxHeightReached) return;

      if (this.queue.isQueueFull) {
        throw new Error('The queue is full, waiting before retry');
      }

      if (this._preloadedItemsQueue.length === 0) {
        await this.preloadBlocksInfo(currentNetworkHeight);

        this.logger.debug('Preloaded block infos for RPC strategy', {
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
    // Caught up — return so loader timer polls again at monitoringInterval
  }

  public async stop(): Promise<void> {
    this._preloadedItemsQueue = [];
    this.logger.verbose('RPC strategy stopped', { module: this.moduleName });
  }

  // ===== INTERNALS =====

  /**
   * Preload block metadata. Dynamically tunes _maxPreloadCount based on timing:
   *   timingRatio > 1.2 → increase by 25% (loader slower → need bigger preload buffer)
   *   timingRatio < 0.8 → decrease by 25%, min 1
   *   0.8–1.2           → no change
   */
  private async preloadBlocksInfo(currentNetworkHeight: number): Promise<void> {
    const previousMaxPreloadCount = this._maxPreloadCount;

    if (this._previousLoadAndEnqueueDuration > 0 && this._lastLoadAndEnqueueDuration > 0) {
      const timingRatio = this._lastLoadAndEnqueueDuration / this._previousLoadAndEnqueueDuration;
      if (timingRatio > 1.2) {
        this._maxPreloadCount = Math.round(this._maxPreloadCount * 1.25);
      } else if (timingRatio < 0.8) {
        this._maxPreloadCount = Math.max(1, Math.round(this._maxPreloadCount * 0.75));
      }
    }

    if (this._maxPreloadCount !== previousMaxPreloadCount) {
      this.logger.verbose('Adjusted RPC preload count based on previous load duration', {
        module: this.moduleName,
        args: {
          previousMaxPreloadCount,
          nextMaxPreloadCount: this._maxPreloadCount,
          previousLoadAndEnqueueDuration: this._previousLoadAndEnqueueDuration,
          lastLoadAndEnqueueDuration: this._lastLoadAndEnqueueDuration,
        },
      });
    }

    const lastHeight = this.queue.lastHeight;
    const remaining = currentNetworkHeight - lastHeight;
    const count = Math.min(this._maxPreloadCount, remaining);
    if (count <= 0) return;

    const heights = Array.from({ length: count }, (_, i) => lastHeight + 1 + i);
    const blockInfos = await this.blockchainProvider.getManyBlocksStatsByHeights(heights);

    for (const { blockhash, total_size, height } of blockInfos) {
      if (!blockhash || height == null) {
        throw new Error('Block infos missing required hash and height');
      }
      const size = total_size != null ? total_size : this.queue.blockSize;
      this._preloadedItemsQueue.push({ hash: blockhash, size, height });
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

    const blocks: Block[] = await this.loadBlocks(infos, retryLimit);

    this.logger.debug('Loaded RPC block batch', {
      module: this.moduleName,
      args: { totalBlocks: blocks.length, totalInfosPulled: infos.length },
    });

    await this.enqueueBlocks(blocks);
    blocks.length = 0;

    this._previousLoadAndEnqueueDuration = this._lastLoadAndEnqueueDuration;
    this._lastLoadAndEnqueueDuration = Date.now() - startTime;
  }

  private async loadBlocks(infos: BlockInfo[], maxRetries: number): Promise<Block[]> {
    let attempt = 0;
    while (attempt < maxRetries) {
      try {
        const heights = infos.map((i) => i.height);
        return await this.blockchainProvider.getManyBlocksByHeights(
          heights,
          true, // useHex = true (bytes path)
          undefined, // verbosity ignored for hex path
          true // verifyMerkle = true
        );
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

  private async enqueueBlocks(blocks: Block[]): Promise<void> {
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
