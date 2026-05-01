export interface IRemoveConfirmedMempoolTxsCommand {
  requestId: string;
  hashes: string[];
  height: number;
}

export class RemoveConfirmedMempoolTxsCommand {
  constructor(public readonly payload: IRemoveConfirmedMempoolTxsCommand) {}
}
