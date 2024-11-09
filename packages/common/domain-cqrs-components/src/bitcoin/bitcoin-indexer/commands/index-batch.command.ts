export interface IIndexBatchCommand {
  batch: any;
  requestId: string;
}

export class IndexBatchCommand {
  constructor(public readonly payload: IIndexBatchCommand) {}
}
