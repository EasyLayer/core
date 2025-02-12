export interface IAddBlocksBatchCommand {
  batch: any;
  requestId: string;
}

export class AddBlocksBatchCommand {
  constructor(public readonly payload: IAddBlocksBatchCommand) {}
}
