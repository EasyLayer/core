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

          // IMPORTANT: We expect that strategy load all blocks to currentNetworkHeight for one method call
          await this._loadingStrategy?.load(currentNetworkHeight);
          this.log.debug('Strategy.load completed, resetting interval');

          resetInterval();
        } catch (error) {
          this.log.debug('Loading blocks on pause, reason: ', {
            args: { error },
          });
          await this._loadingStrategy?.stop();
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

  private createStrategy(queue: BlocksQueue<Block>): void {
    const name = this.config.queueLoaderStrategyName;

    switch (name) {
      case StrategyNames.PULL:
        this._loadingStrategy = new PullNetworkProviderStrategy(this.log, this.blockchainProviderService, queue, {
          maxRequestBlocksBatchSize: this.config.queueLoaderRequestBlocksBatchSize,
          concurrency: this.config.queueLoaderConcurrency,
          basePreloadCount: this.config.basePreloadCount,
        });
        break;
      default:
        throw new Error(`Unknown strategy: ${name}`);
    }
  }
}
