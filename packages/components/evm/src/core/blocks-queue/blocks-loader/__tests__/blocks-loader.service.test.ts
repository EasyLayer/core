import { exponentialIntervalAsync } from '@easylayer/common/exponential-interval-async';
import { BlocksQueueLoaderService } from '../blocks-loader.service';
import { BlocksQueue } from '../../blocks-queue';
import type { Block } from '../../../blockchain-provider/components/block.interfaces';
import { SubscribeWsProviderStrategy } from '../load-strategies/subscribe-ws-provider.strategy';

jest.mock('@easylayer/common/exponential-interval-async', () => ({
  exponentialIntervalAsync: jest.fn(),
}));

function createQueue(lastHeight: number): BlocksQueue<Block> {
  return new BlocksQueue<Block>({
    lastHeight,
    maxQueueSize: 50 * 1024 * 1024,
    blockSize: 500,
    maxBlockHeight: Number.MAX_SAFE_INTEGER,
  });
}

describe('BlocksQueueLoaderService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it('refreshes mempool before loading blocks on each tick', async () => {
    const callOrder: string[] = [];
    const provider = {
      getCurrentBlockHeightFromNetwork: jest.fn().mockImplementation(async () => {
        callOrder.push('height');
        return 10;
      }),
    };
    const mempoolService = {
      refresh: jest.fn().mockImplementation(async () => {
        callOrder.push('refresh');
      }),
    };

    const loadSpy = jest.spyOn(SubscribeWsProviderStrategy.prototype, 'load').mockImplementation(async () => {
      callOrder.push('load');
    });

    let tick: ((reset: () => void) => Promise<void>) | undefined;
    (exponentialIntervalAsync as jest.Mock).mockImplementation((cb: (reset: () => void) => Promise<void>) => {
      tick = cb;
      return { destroy: jest.fn() };
    });

    const service = new BlocksQueueLoaderService(provider as any, mempoolService as any, {
      blockTimeMs: 12_000,
      queueLoaderRequestBlocksBatchSize: 8_000_000,
      basePreloadCount: 10,
      tracesEnabled: false,
      verifyTrie: false,
      queueLoaderStrategyName: 'ws-subscribe',
      strategyThreshold: 20,
    });

    await service.startBlocksLoading(createQueue(9));
    expect(typeof tick).toBe('function');

    await tick!(jest.fn());

    expect(mempoolService.refresh).toHaveBeenCalledWith(10);
    expect(loadSpy).toHaveBeenCalledWith(10);
    expect(callOrder).toEqual(['height', 'refresh', 'load']);
  });
});
