export interface IHandleBatchCommand {
  batch: any;
  requestId: string;
}

export class HandleBatchCommand {
  constructor(public readonly payload: IHandleBatchCommand) {}
}
