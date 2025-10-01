export * from './check-mempool-transaction.query';
export * from './get-mempool-stats.query';
export * from './get-mempool-transactions.query';
export * from './get-mempool-txids.query';

import { CheckMempoolTransactionQuery, CheckMempoolTransactionQueryDto } from './check-mempool-transaction.query';
import { GetMempoolStatsQuery, GetMempoolStatsQueryDto } from './get-mempool-stats.query';
import { GetMempoolTransactionsQuery, GetMempoolTransactionsQueryDto } from './get-mempool-transactions.query';
import { GetMempoolTxidsQuery, GetMempoolTxidsQueryDto } from './get-mempool-txids.query';

export const MempoolQueries = [
  CheckMempoolTransactionQuery,
  GetMempoolStatsQuery,
  GetMempoolTransactionsQuery,
  GetMempoolTxidsQuery,
];

export const MempoolQueryDtos = [
  CheckMempoolTransactionQueryDto,
  GetMempoolStatsQueryDto,
  GetMempoolTransactionsQueryDto,
  GetMempoolTxidsQueryDto,
];

export const MempoolQueryDtoMap = new Map([
  [CheckMempoolTransactionQuery, CheckMempoolTransactionQueryDto],
  [GetMempoolStatsQuery, GetMempoolStatsQueryDto],
  [GetMempoolTransactionsQuery, GetMempoolTransactionsQueryDto],
  [GetMempoolTxidsQuery, GetMempoolTxidsQueryDto],
]);
