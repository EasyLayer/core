export interface IProcessMempoolSyncCommand {
  requestId: string;
  hasMoreToProcess?: boolean;
}

export class ProcessMempoolSyncCommand {
  constructor(public readonly payload: IProcessMempoolSyncCommand) {}
}
