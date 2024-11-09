export interface ILoadBatchCommand {
  batch: any;
  requestId: string;
}

export class LoadBatchCommand {
  constructor(public readonly payload: ILoadBatchCommand) {}
}
