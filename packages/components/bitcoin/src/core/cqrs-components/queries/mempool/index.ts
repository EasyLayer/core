export * from './check-mempool-transaction-full.query';
export * from './get-mempool-overview.query';
export * from './get-list-mempool-transactions.query';
export * from './get-list-mempool-txids.query';

import {
  CheckMempoolTransactionFullQuery,
  CheckMempoolTransactionFullQueryDto,
} from './check-mempool-transaction-full.query';
import { GetMempoolOverviewQuery, GetMempoolOverviewQueryDto } from './get-mempool-overview.query';
import {
  GetListMempoolTransactionsQuery,
  GetListMempoolTransactionsQueryDto,
} from './get-list-mempool-transactions.query';
import { GetListMempoolTxidsQuery, GetListMempoolTxidsQueryDto } from './get-list-mempool-txids.query';

export const MempoolQueries = [
  CheckMempoolTransactionFullQuery,
  GetMempoolOverviewQuery,
  GetListMempoolTransactionsQuery,
  GetListMempoolTxidsQuery,
];

export const MempoolQueryDtos = [
  CheckMempoolTransactionFullQueryDto,
  GetMempoolOverviewQueryDto,
  GetListMempoolTransactionsQueryDto,
  GetListMempoolTxidsQueryDto,
];

export const MempoolQueryDtoMap = new Map([
  [CheckMempoolTransactionFullQuery, CheckMempoolTransactionFullQueryDto],
  [GetMempoolOverviewQuery, GetMempoolOverviewQueryDto],
  [GetListMempoolTransactionsQuery, GetListMempoolTransactionsQueryDto],
  [GetListMempoolTxidsQuery, GetListMempoolTxidsQueryDto],
]);
