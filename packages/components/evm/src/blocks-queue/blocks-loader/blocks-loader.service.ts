import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { AppLogger } from '@easylayer/common/logger';
import { BlockchainProviderService } from '../../blockchain-provider';
import { exponentialIntervalAsync, ExponentialTimer } from '@easylayer/common/exponential-interval-async';
import type { Block } from '../../blockchain-provider';
import { BlocksQueue } from '../blocks-queue';
import {
  PullNetworkProviderStrategy,
  SubscribeBlocksProviderStrategy,
  BlocksLoadingStrategy,
  StrategyNames,
} from './load-strategies';

@Injectable()
export class BlocksQueueLoaderService implements OnModuleDestroy {
  private _isLoading: boolean = false;
  private _timer: ExponentialTimer | null = null;
  private _currentStrategy: BlocksLoadingStrategy | null = null;

  private readonly _strategies: Map<StrategyNames, BlocksLoadingStrategy> = new Map();

  constructor(
    private readonly log: AppLogger,
    private readonly blockchainProviderService: BlockchainProviderService,
    private readonly config: any
  ) {}

  get isLoading(): boolean {
    return this._isLoading;
  }

  async onModuleDestroy() {
    this.log.debug('Blocks queue loader service is shutting down');
    await this._currentStrategy?.stop();
    this._timer?.destroy();
    this._timer = null;
    this._currentStrategy = null;
    this._strategies.clear();
    this._isLoading = false;
  }

  public async startBlocksLoading(queue: BlocksQueue<Block>): Promise<void> {
    this.log.debug('Start blocks loading from height', {
      args: { initialLastHeight: queue.lastHeight },
    });

    // NOTE: We use this to make sure that
    // method startBlocksLoading() is executed only once in its entire life.
    if (this._isLoading) {
      this.log.debug('Blocks loading skipped: already loading');
      return;
    }

    this._isLoading = true;

    // Create strategies with queue
    this.createStrategies(queue);

    this.log.info('Loading strategy created', {
      args: { strategy: this.config.queueLoaderStrategyName },
    });

    this._timer = exponentialIntervalAsync(
      async (resetInterval) => {
        try {
          // IMPORTANT: every exponential tick we fetch current blockchain network height
          const currentNetworkHeight = await this.blockchainProviderService.getCurrentBlockHeight();
          this.log.debug('Current blockchain network height fetched', {
            args: { queueLastHeight: queue.lastHeight, currentNetworkHeight },
          });

          // Get the strategy that should work now
          this._currentStrategy = this.getCurrentStrategy(queue, currentNetworkHeight);

          this.log.info('Loading strategy created', {
            args: { strategy: this._currentStrategy?.name },
          });

          // IMPORTANT: We expect that strategy load all blocks to currentNetworkHeight for one method call
          await this._currentStrategy?.load(currentNetworkHeight);
          this.log.debug('Strategy.load completed, resetting interval');
          resetInterval();
        } catch (error) {
          this.log.debug('Loading blocks on pause, reason: ', {
            args: { error },
          });
          await this._currentStrategy?.stop();
        }
      },
      {
        interval: 500,
        maxInterval: 3000,
        multiplier: 2,
      }
    );

    this.log.debug('Loader exponential timer started');
  }

  // Factory method to create strategies
  private createStrategies(queue: BlocksQueue<Block>): void {
    const strategyOptions = {
      maxRequestBlocksBatchSize: this.config.queueLoaderRequestBlocksBatchSize,
      concurrency: this.config.queueLoaderConcurrency,
      basePreloadCount: this.config.basePreloadCount,
    };

    this._strategies.set(
      StrategyNames.PULL,
      new PullNetworkProviderStrategy(this.log, this.blockchainProviderService, queue, strategyOptions)
    );

    this._strategies.set(
      StrategyNames.SUBSCRIBE,
      new SubscribeBlocksProviderStrategy(this.log, this.blockchainProviderService, queue, strategyOptions)
    );
  }

  // Business rule method to determine which strategy should work
  private getCurrentStrategy(queue: BlocksQueue<Block>, currentNetworkHeight?: number): BlocksLoadingStrategy {
    const configStrategy = this.config.queueLoaderStrategyName;

    // If config is PULL - always use PULL
    if (configStrategy === StrategyNames.PULL) {
      return this._strategies.get(StrategyNames.PULL)!;
    }

    // If config is SUBSCRIBE but big height difference - use PULL
    if (currentNetworkHeight !== undefined) {
      const heightDifference = currentNetworkHeight - queue.lastHeight;
      const threshold = this.config.strategyThreshold || 20;

      if (heightDifference > threshold) {
        return this._strategies.get(StrategyNames.PULL)!;
      }
    }

    // Default to use configured strategy (SUBSCRIBE)
    return this._strategies.get(StrategyNames.SUBSCRIBE)!;
  }
}
