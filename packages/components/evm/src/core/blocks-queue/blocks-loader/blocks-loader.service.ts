import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { exponentialIntervalAsync, ExponentialTimer } from '@easylayer/common/exponential-interval-async';
import type { BlockchainProviderService } from '../../blockchain-provider/blockchain-provider.service';
import type { Block } from '../../blockchain-provider/components/block.interfaces';
import { BlocksQueue } from '../blocks-queue';
import { RpcProviderStrategy, SubscribeWsProviderStrategy } from './load-strategies';
import type { BlocksLoadingStrategy } from './load-strategies/load-strategy.interface';
import { StrategyNames } from './load-strategies/load-strategy.interface';
import type { MempoolLoaderService } from '../mempool-loader.service';

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
    private readonly mempoolService: MempoolLoaderService,
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

    this._isLoading = true;
    this.createStrategies(queue);

    this._timer = exponentialIntervalAsync(
      async (resetInterval: () => void) => {
        try {
          const currentNetworkHeight = await this.blockchainProviderService.getCurrentBlockHeightFromNetwork();

          await this.mempoolService.refresh(currentNetworkHeight);

          this._currentStrategy = this.getCurrentStrategy(queue, currentNetworkHeight);
          await this._currentStrategy?.load(currentNetworkHeight);
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
      verifyTrie: this.config.verifyTrie ?? false,
    };

    this._strategies.set(
      StrategyNames.RPC,
      new RpcProviderStrategy(this.log as any, this.blockchainProviderService, queue, opts)
    );
    this._strategies.set(
      StrategyNames.WS_SUBSCRIBE,
      new SubscribeWsProviderStrategy(this.log as any, this.blockchainProviderService, queue, opts)
    );
  }

  private getCurrentStrategy(queue: BlocksQueue<Block>, currentNetworkHeight?: number): BlocksLoadingStrategy {
    const configStrategy = this.config.queueLoaderStrategyName;
    if (configStrategy === StrategyNames.RPC) {
      return this._strategies.get(StrategyNames.RPC)!;
    }
    if (currentNetworkHeight !== undefined) {
      const diff = currentNetworkHeight - queue.lastHeight;
      const threshold = this.config.strategyThreshold || 20;
      if (diff > threshold) return this._strategies.get(StrategyNames.RPC)!;
    }
    return this._strategies.get(StrategyNames.WS_SUBSCRIBE)!;
  }
}
