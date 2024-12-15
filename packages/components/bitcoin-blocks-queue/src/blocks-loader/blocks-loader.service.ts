import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { AppLogger } from '@easylayer/components/logger';
import { NetworkProviderService } from '@easylayer/components/bitcoin-network-provider';
import { exponentialIntervalAsync, ExponentialTimer } from '@easylayer/common/exponential-interval-async';
import { BlocksQueue } from '../blocks-queue';
import { Block } from '../interfaces';
import { PullNetworkProviderStrategy, BlocksLoadingStrategy, StrategyNames } from './load-strategies';

@Injectable()
export class BlocksQueueLoaderService implements OnModuleDestroy {
  private _isLoading: boolean = false;
  private _loadingStrategy: BlocksLoadingStrategy | null = null;
  private _timer: ExponentialTimer | null = null;

  constructor(
    private readonly log: AppLogger,
    private readonly networkProviderService: NetworkProviderService,
    private readonly config: any
  ) {}

  get isLoading(): boolean {
    return this._isLoading;
  }

  async onModuleDestroy() {
    await this._loadingStrategy?.stop();
    this._timer?.destroy();
    this._timer = null;
    this._loadingStrategy = null;
    this._isLoading = false;
  }

  public async startBlocksLoading(queue: BlocksQueue<Block>): Promise<void> {
    this.log.info('Setup blocks loading from height', {}, this.constructor.name);

    // NOTE: We use this to make sure that
    // method startBlocksLoading() is executed only once in its entire life.
    if (this._isLoading) {
      return;
    }

    this._isLoading = true;

    this.createStrategy(queue);

    this._timer = exponentialIntervalAsync(
      async (resetInterval) => {
        try {
          // IMPORTANT: every exponential tick we fetch current blockchain network height
          const currentNetworkHeight = await this.networkProviderService.getCurrentBlockHeight();

          this.log.debug(
            'Current blockchain network height',
            { queueLastHeight: queue.lastHeight, height: currentNetworkHeight },
            this.constructor.name
          );

          // IMPORTANT: We expect that strategy load all blocks to currentNetworkHeight for one method call
          await this._loadingStrategy?.load(currentNetworkHeight);
          resetInterval();
        } catch (error) {
          this.log.error('Loading strategy error', error, this.constructor.name);
          await this._loadingStrategy?.stop();
        }
      },
      {
        interval: 500,
        maxInterval: 3000,
        multiplier: 2,
      }
    );
  }

  private createStrategy(queue: BlocksQueue<Block>): void {
    const name = this.config.queueLoaderStrategyName;

    switch (name) {
      case StrategyNames.PULL_NETWORK_PROVIDER:
        this._loadingStrategy = new PullNetworkProviderStrategy(this.log, this.networkProviderService, queue, {
          maxRequestBlocksBatchSize: this.config.queueLoaderRequestBlocksBatchSize,
          concurrency: this.config.queueLoaderConcurrency,
          isTest: this.config.isTest,
        });
        break;
      default:
        throw new Error(`Unknown strategy: ${name}`);
    }
  }
}
