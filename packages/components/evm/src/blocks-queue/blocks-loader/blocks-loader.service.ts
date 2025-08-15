import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { AppLogger } from '@easylayer/common/logger';
import { BlockchainProviderService } from '../../blockchain-provider';
import { exponentialIntervalAsync, ExponentialTimer } from '@easylayer/common/exponential-interval-async';
import type { Block } from '../../blockchain-provider';
import { BlocksQueue } from '../blocks-queue';
import {
  PullRpcProviderStrategy,
  SubscribeWsProviderStrategy,
  BlocksLoadingStrategy,
  StrategyNames,
} from './load-strategies';

@Injectable()
export class BlocksQueueLoaderService implements OnModuleDestroy {
  private _isLoading: boolean = false;
  private _timer: ExponentialTimer | null = null;
  private _currentStrategy: BlocksLoadingStrategy | null = null;
  private readonly _monitoringInterval: number;
  private readonly _strategies: Map<StrategyNames, BlocksLoadingStrategy> = new Map();

  constructor(
    private readonly log: AppLogger,
    private readonly blockchainProviderService: BlockchainProviderService,
    private readonly config: any
  ) {
    // Calculate monitoring interval once in constructor
    // Half of block time, minimum 30 seconds
    this._monitoringInterval = Math.max(this.config.blockTimeMs / 2, 3000);
  }

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

          this.log.debug('Loading strategy created', {
            args: { strategy: this._currentStrategy?.name },
          });

          // IMPORTANT: We expect that strategy load all blocks to currentNetworkHeight for one method call
          await this._currentStrategy?.load(currentNetworkHeight);

          // SUCCESS CASE: Don't reset interval, let it continue with maxInterval (monitoring mode)
          // Next attempt will be in ~monitoringInterval ms (half of block time)
        } catch (error) {
          this.log.debug('Loading blocks on pause, reason: ', {
            args: { error },
          });
          await this._currentStrategy?.stop();

          // ERROR CASE: Reset interval to retry immediately
          // because error means we didn't load blocks to currentHeight so we need to try again ASAP
          // Next attempt will be exponential: 1000ms -> 10000ms -> 100000ms -> up to maxInterval
          resetInterval();
        }
      },
      {
        interval: 1000, // Start with 1000ms for first attempts
        maxInterval: this._monitoringInterval, // Max interval = monitoring interval (half block time)
        multiplier: 2, // Exponential backoff multiplier
      }
    );

    this.log.debug('Loader exponential timer started');
  }

  // Factory method to create strategies
  private createStrategies(queue: BlocksQueue<Block>): void {
    const strategyOptions = {
      maxRequestBlocksBatchSize: this.config.queueLoaderRequestBlocksBatchSize,
      basePreloadCount: this.config.basePreloadCount,
    };

    this._strategies.set(
      StrategyNames.RPC_PULL,
      new PullRpcProviderStrategy(this.log, this.blockchainProviderService, queue, strategyOptions)
    );

    this._strategies.set(
      StrategyNames.WS_SUBSCRIBE,
      new SubscribeWsProviderStrategy(this.log, this.blockchainProviderService, queue, strategyOptions)
    );
  }

  // Business rule method to determine which strategy should work
  private getCurrentStrategy(queue: BlocksQueue<Block>, currentNetworkHeight?: number): BlocksLoadingStrategy {
    const configStrategy = this.config.queueLoaderStrategyName;

    // If config is PULL - always use PULL
    if (configStrategy === StrategyNames.RPC_PULL) {
      return this._strategies.get(StrategyNames.RPC_PULL)!;
    }

    // If config is SUBSCRIBE but big height difference - use PULL
    if (currentNetworkHeight !== undefined) {
      const heightDifference = currentNetworkHeight - queue.lastHeight;
      const threshold = this.config.strategyThreshold || 20;

      if (heightDifference > threshold) {
        return this._strategies.get(StrategyNames.RPC_PULL)!;
      }
    }

    // Default to use configured strategy
    return this._strategies.get(StrategyNames.WS_SUBSCRIBE)!;
  }
}
