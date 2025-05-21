import type { AppLogger } from '@easylayer/common/logger';
import { RuntimeTracker } from '@easylayer/common/logger';
import type { BlockchainProviderService } from '../../../blockchain-provider';
import type { Block } from '../../../blockchain-provider';
import type { BlocksLoadingStrategy } from './load-strategy.interface';
import { StrategyNames } from './load-strategy.interface';
import type { BlocksQueue } from '../../blocks-queue';

export class SubscribeBlocksProviderStrategy implements BlocksLoadingStrategy {
  readonly name: StrategyNames = StrategyNames.SUBSCRIBE_BLOCKS_PROVIDER;

  constructor(
    private readonly log: AppLogger,
    private readonly blockchainProvider: BlockchainProviderService,
    private readonly queue: BlocksQueue<Block>,
    config: any
  ) {}

  public async load(currentNetworkHeight: number): Promise<void> {
    throw new Error(`${this.name} strategy is not implemented yet.`);
  }

  public async stop(): Promise<void> {}
}
