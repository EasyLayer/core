import { QueryDoc } from '@easylayer/common/shared-interfaces';

export interface IGetMempoolOverviewQuery {}
export class GetMempoolOverviewQueryDto {}

@QueryDoc({
  description:
    'Retrieves a concise EVM mempool overview: pending count, loaded count, providers and replacement index size.',
  category: 'Mempool',
})
export class GetMempoolOverviewQuery {
  constructor(public readonly payload: IGetMempoolOverviewQuery) {}
}
