import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { AppLogger } from '@easylayer/common/logger';
import { exponentialIntervalAsync, ExponentialTimer } from '@easylayer/common/exponential-interval-async';
import { BlockchainProviderService, Block } from '../../blockchain-provider';
import { BlocksQueue } from '../blocks-queue';
import { PullNetworkProviderStrategy, BlocksLoadingStrategy, StrategyNames } from './load-strategies';

@Injectable()
export class BlocksQueueLoaderService implements OnModuleDestroy {
  private _isLoading: boolean = false;
  private _loadingStrategy: BlocksLoadingStrategy | null = null;
  private _timer: ExponentialTimer | null = null;
  private readonly _monitoringInterval: number;

  constructor(
    private readonly log: AppLogger,
    private readonly blockchainProviderService: BlockchainProviderService,
    private readonly config: any
  ) {
    // Calculate monitoring interval once in constructor
    // Half of block time, minimum 30 seconds
    this._monitoringInterval = Math.max(this.config.blockTimeMs / 2, 30000);
  }

  get isLoading(): boolean {
    return this._isLoading;
  }

  async onModuleDestroy() {
    this.log.debug('Blocks queue loader service is shutting down');
    await this._loadingStrategy?.stop();
    this._timer?.destroy();
    this._timer = null;
    this._loadingStrategy = null;
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

    this.createStrategy(queue);

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

          // IMPORTANT: We expect that strategy loads all blocks to currentNetworkHeight for one method call
          await this._loadingStrategy?.load(currentNetworkHeight);

          // SUCCESS CASE: Don't reset interval, let it continue with maxInterval (monitoring mode)
          // Next attempt will be in ~monitoringInterval ms (half of block time)
        } catch (error) {
          this.log.debug('Loading blocks failed, retrying immediately', {
            args: { error },
          });

          await this._loadingStrategy?.stop();

          // ERROR CASE: Reset interval to retry immediately
          // because error means we didn't load blocks to currentHeight so we need to try again ASAP
          // Next attempt will be exponential: 1000ms -> 10000ms -> 100000ms -> up to maxInterval
          resetInterval();
        }
      },
      {
        interval: 1000, // Start with 1000ms for first attempts
        maxInterval: this._monitoringInterval, // Max interval = monitoring interval (half block time)
        multiplier: 10, // Exponential backoff multiplier
      }
    );

    this.log.debug('Loader exponential timer started');
  }

  private createStrategy(queue: BlocksQueue<Block>): void {
    const name = this.config.queueLoaderStrategyName;

    switch (name) {
      case StrategyNames.PULL:
        this._loadingStrategy = new PullNetworkProviderStrategy(this.log, this.blockchainProviderService, queue, {
          maxRequestBlocksBatchSize: this.config.queueLoaderRequestBlocksBatchSize,
          basePreloadCount: this.config.basePreloadCount,
        });
        break;
      default:
        throw new Error(`Unknown strategy: ${name}`);
    }
  }
}
