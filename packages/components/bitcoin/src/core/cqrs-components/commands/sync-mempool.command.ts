export interface ISyncMempoolCommand {
  requestId: string;
}

export class SyncMempoolCommand {
  constructor(public readonly payload: ISyncMempoolCommand) {}
}
