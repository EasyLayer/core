import type { MempoolTxMetadata } from '../../blockchain-provider';

export interface IRefreshMempoolCommand {
  requestId: string;
  height: number;
  perProvider: Record<
    string, // provider name
    Array<{ txid: string; metadata: MempoolTxMetadata }>
  >;
}

export class RefreshMempoolCommand {
  constructor(public readonly payload: IRefreshMempoolCommand) {}
}
