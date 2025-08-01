export interface IProcessMempoolBlocksBatchCommand {
  requestId: string;
  blocks: Array<{ height: number; hash: string }>;
}

export class ProcessMempoolBlocksBatchCommand {
  constructor(public readonly payload: IProcessMempoolBlocksBatchCommand) {}
}
