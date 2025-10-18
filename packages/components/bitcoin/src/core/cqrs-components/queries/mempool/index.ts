export * from './check-mempool-transaction-full.query';
export * from './get-mempool-overview.query';

import {
  CheckMempoolTransactionFullQuery,
  CheckMempoolTransactionFullQueryDto,
} from './check-mempool-transaction-full.query';
import { GetMempoolOverviewQuery, GetMempoolOverviewQueryDto } from './get-mempool-overview.query';

export const MempoolQueries = [CheckMempoolTransactionFullQuery, GetMempoolOverviewQuery];

export const MempoolQueryDtos = [CheckMempoolTransactionFullQueryDto, GetMempoolOverviewQueryDto];

export const MempoolQueryDtoMap = new Map([
  [CheckMempoolTransactionFullQuery, CheckMempoolTransactionFullQueryDto],
  [GetMempoolOverviewQuery, GetMempoolOverviewQueryDto],
]);
