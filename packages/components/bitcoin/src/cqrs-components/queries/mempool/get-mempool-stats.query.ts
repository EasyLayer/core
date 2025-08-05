import { QueryDoc } from '@easylayer/common/shared-interfaces';

export interface IGetMempoolStatsQuery {}

export class GetMempoolStatsQueryDto {}

@QueryDoc({
  description: 'Retrieves mempool statistics and synchronization status',
  category: 'Mempool',
  examples: {
    request: {
      requestId: 'uuid-2',
      action: 'query',
      payload: {
        constructorName: 'GetMempoolStatsQuery',
        dto: {},
      },
    },
    response: {
      totalTxids: 50000,
      loadedTransactions: 45000,
      isSynchronized: true,
      fullSyncThreshold: 10000,
      currentBatchSize: 150,
      syncTimingInfo: {
        previous: 1200,
        last: 950,
        ratio: 0.79,
      },
    },
  },
})
export class GetMempoolStatsQuery {
  constructor(public readonly payload: IGetMempoolStatsQuery) {}
}
