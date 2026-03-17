import { Injectable, OnModuleDestroy, Logger, OnModuleInit } from '@nestjs/common';
import { BlockchainProviderService } from '../../blockchain-provider';
import { exponentialIntervalAsync, ExponentialTimer } from '@easylayer/common/exponential-interval-async';
import type { Block } from '../../blockchain-provider';
import { BlocksQueue } from '../blocks-queue';
import {
  RpcProviderStrategy,
  RpcZmqProviderStrategy,
  P2PProviderStrategy,
  BlocksLoadingStrategy,
  StrategyNames,
} from './load-strategies';
import { MempoolLoaderService } from '../mempool-loader.service';

@Injectable()
export class BlocksQueueLoaderService implements OnModuleDestroy, OnModuleInit {
  private readonly logger = new Logger(BlocksQueueLoaderService.name);
  private readonly moduleName = 'blocks-queue';
  private _isLoading: boolean = false;
  private _timer: ExponentialTimer | null = null;
  private _currentStrategy: BlocksLoadingStrategy | null = null;
  private readonly _monitoringInterval: number;
  private readonly _startInterval: number = 2000;
  private readonly _strategies: Map<StrategyNames, BlocksLoadingStrategy> = new Map();

  constructor(
    private readonly blockchainProviderService: BlockchainProviderService,
    private readonly mempoolService: MempoolLoaderService,
    private readonly config: any
  ) {
    // Calculate monitoring interval once in constructor
    // Half of block time, minimum 30 seconds
    this._monitoringInterval = Math.max(this.config.blockTimeMs / 10, 30000);
  }

  get isLoading(): boolean {
    return this._isLoading;
  }

  onModuleInit() {
    this.logger.verbose('Blocks queue loader service initialized', {
      module: this.moduleName,
    });
  }

  async onModuleDestroy() {
    this.logger.verbose('Blocks queue loader service is shutting down', {
      module: this.moduleName,
    });
    await this._currentStrategy?.stop();
    this._timer?.destroy();
    this._timer = null;
    this._currentStrategy = null;
    this._strategies.clear();
    this._isLoading = false;
  }

  public async startBlocksLoading(queue: BlocksQueue<Block>): Promise<void> {
    // NOTE: We use this to make sure that
    // method startBlocksLoading() is executed only once in its entire life.
    if (this._isLoading) {
      return;
    }

    this.logger.debug('Start blocks loading from height', {
      module: this.moduleName,
      args: {
        initialLastHeight: queue.lastHeight,
        queueLoaderStrategyName: this.config.queueLoaderStrategyName,
        startInterval: this._startInterval,
        maxInterval: this._monitoringInterval,
      },
    });

    this._isLoading = true;

    // Create strategies with queue
    this.createStrategies(queue);

    this._timer = exponentialIntervalAsync(
      async (resetInterval) => {
        try {
          // IMPORTANT: every exponential tick we fetch current blockchain network height
          const currentNetworkHeight = await this.blockchainProviderService.getCurrentBlockHeightFromNetwork();
          this.logger.verbose('Fetch blockchain network height', {
            module: this.moduleName,
            args: { queueLastHeight: queue.lastHeight, currentNetworkHeight },
          });

          await this.mempoolService.refresh(currentNetworkHeight);

          // Get the strategy that should work now
          this._currentStrategy = this.getCurrentStrategy();

          this.logger.verbose('Loading strategy created', {
            module: this.moduleName,
            args: { strategy: this._currentStrategy?.name },
          });

          // IMPORTANT: We expect that strategy load all blocks to currentNetworkHeight for one method call
          await this._currentStrategy?.load(currentNetworkHeight);

          // SUCCESS CASE: Don't reset interval, let it continue with maxInterval (monitoring mode)
          // Next attempt will be in ~monitoringInterval ms (half of block time)
        } catch (error) {
          this.logger.verbose('Loading blocks on pause', {
            module: this.moduleName,
            args: { action: 'load', error },
          });
          await this._currentStrategy?.stop();

          // ERROR CASE: Reset interval to retry immediately
          // because error means we didn't load blocks to currentHeight so we need to try again ASAP
          // Next attempt will be exponential: 1000ms -> 10000ms -> 100000ms -> up to maxInterval
          resetInterval();
        }
      },
      {
        interval: this._startInterval, // Start with 1000ms for first attempts
        maxInterval: this._monitoringInterval, // Max interval = monitoring interval (half block time)
        multiplier: 1.6, // Exponential backoff multiplier
      }
    );

    this.logger.debug('Loader exponential timer started', {
      module: this.moduleName,
    });
  }

  // Factory method to create strategies
  private createStrategies(queue: BlocksQueue<Block>): void {
    const strategyOptions = {
      maxRpcReplyBytes: this.config.queueLoaderRequestBlocksBatchSize,
      basePreloadCount: this.config.basePreloadCount,
    };

    this._strategies.set(
      StrategyNames.RPC,
      new RpcProviderStrategy(this.logger, this.blockchainProviderService, queue, strategyOptions)
    );

    this._strategies.set(
      StrategyNames.RPC_ZMQ,
      new RpcZmqProviderStrategy(this.logger, this.blockchainProviderService, queue, strategyOptions)
    );

    this._strategies.set(
      StrategyNames.P2P,
      new P2PProviderStrategy(this.logger, this.blockchainProviderService, queue)
    );
  }

  // Each strategy is self-contained: handles its own catch-up → real-time transition internally.
  // The loader is a pure supervisor — picks the configured strategy and runs it.
  // No threshold switching needed here anymore.
  private getCurrentStrategy(): BlocksLoadingStrategy {
    const configStrategy = this.config.queueLoaderStrategyName as StrategyNames;
    return this._strategies.get(configStrategy) ?? this._strategies.get(StrategyNames.RPC)!;
  }
}
