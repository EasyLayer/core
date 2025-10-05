import { QueryDoc } from '@easylayer/common/shared-interfaces';

export interface IGetMempoolOverviewQuery {}
export class GetMempoolOverviewQueryDto {}

@QueryDoc({
  description: 'Retrieves a concise overview of mempool: stats, size estimates, sync progress, providers.',
  category: 'Mempool',
  examples: {
    request: {
      requestId: 'uuid-2',
      action: 'query',
      payload: { constructorName: 'GetMempoolOverviewQuery', dto: {} },
    },
    response: {
      stats: { totalTxids: 50213 /* … */ },
      size: { estimatedMemoryUsage: { total: 134217728 } /* … */ },
      sync: { progress: 0.91, totalExpected: 48000, loaded: 43680, remaining: 4320 },
      providers: ['provider_0', 'provider_1'],
    },
  },
})
export class GetMempoolOverviewQuery {
  constructor(public readonly payload: IGetMempoolOverviewQuery) {}
}
