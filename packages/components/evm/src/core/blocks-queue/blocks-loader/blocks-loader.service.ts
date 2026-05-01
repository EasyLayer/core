import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import { exponentialIntervalAsync, ExponentialTimer } from '@easylayer/common/exponential-interval-async';
import type { BlockchainProviderService } from '../../blockchain-provider/blockchain-provider.service';
import type { Block } from '../../blockchain-provider/components/block.interfaces';
import { BlocksQueue } from '../blocks-queue';
import {
  PullRpcProviderStrategy,
  SubscribeWsProviderStrategy,
  BlocksLoadingStrategy,
  StrategyNames,
} from './load-strategies';

@Injectable()
export class BlocksQueueLoaderService implements OnModuleDestroy {
  private readonly log = new Logger(BlocksQueueLoaderService.name);
  private _isLoading = false;
  private _timer: ExponentialTimer | null = null;
  private _currentStrategy: BlocksLoadingStrategy | null = null;
  private readonly _monitoringInterval: number;
  private readonly _strategies: Map<StrategyNames, BlocksLoadingStrategy> = new Map();

  constructor(
    private readonly blockchainProviderService: BlockchainProviderService,
    private readonly config: any
  ) {
    this._monitoringInterval = Math.max(this.config.blockTimeMs / 2, 3000);
  }

  get isLoading(): boolean {
    return this._isLoading;
  }

  async onModuleDestroy() {
    await this._currentStrategy?.stop();
    this._timer?.destroy();
    this._timer = null;
    this._currentStrategy = null;
    this._strategies.clear();
    this._isLoading = false;
  }

  public async startBlocksLoading(queue: BlocksQueue<Block>): Promise<void> {
    if (this._isLoading) return;
    await this.blockchainProviderService.assertRuntimeCompatibility({
      tracesEnabled: this.config.tracesEnabled,
    });
    this._isLoading = true;
    this.createStrategies(queue);

    this._timer = exponentialIntervalAsync(
      async (resetInterval: () => void) => {
        try {
          // Use getCurrentBlockHeightFromNetwork (alias for getCurrentBlockHeight)
          const currentNetworkHeight = await this.blockchainProviderService.getCurrentBlockHeightFromNetwork();

          this._currentStrategy = this.getCurrentStrategy(queue, currentNetworkHeight);

          await this._currentStrategy?.load(currentNetworkHeight);

          // SUCCESS: continue with maxInterval (monitoring mode)
        } catch (error) {
          this.log.debug('Loading blocks on pause', { args: { error } });
          await this._currentStrategy?.stop();
          resetInterval();
        }
      },
      { interval: 1000, maxInterval: this._monitoringInterval, multiplier: 2 }
    );
  }

  private createStrategies(queue: BlocksQueue<Block>): void {
    const opts = {
      maxRequestBlocksBatchSize: this.config.queueLoaderRequestBlocksBatchSize,
      basePreloadCount: this.config.basePreloadCount,
      tracesEnabled: this.config.tracesEnabled ?? false,
    };

    this._strategies.set(
      StrategyNames.RPC_PULL,
      new PullRpcProviderStrategy(this.log, this.blockchainProviderService, queue, opts)
    );
    this._strategies.set(
      StrategyNames.WS_SUBSCRIBE,
      new SubscribeWsProviderStrategy(this.log, this.blockchainProviderService, queue, opts)
    );
  }

  private getCurrentStrategy(queue: BlocksQueue<Block>, currentNetworkHeight?: number): BlocksLoadingStrategy {
    const configStrategy = this.config.queueLoaderStrategyName;
    if (configStrategy === StrategyNames.RPC_PULL) {
      return this._strategies.get(StrategyNames.RPC_PULL)!;
    }
    if (currentNetworkHeight !== undefined) {
      const diff = currentNetworkHeight - queue.lastHeight;
      const threshold = this.config.strategyThreshold || 20;
      if (diff > threshold) return this._strategies.get(StrategyNames.RPC_PULL)!;
    }
    return this._strategies.get(StrategyNames.WS_SUBSCRIBE)!;
  }
}
