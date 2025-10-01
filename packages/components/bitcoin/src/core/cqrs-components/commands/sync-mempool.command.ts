export interface ISyncMempoolCommand {
  requestId: string;
  hasMoreToProcess?: boolean;
}

export class SyncMempoolCommand {
  constructor(public readonly payload: ISyncMempoolCommand) {}
}
