import type { Block } from '../../blockchain-provider';

export interface IAddBlocksBatchCommand {
  batch: Block[];
  requestId: string;
}

export class AddBlocksBatchCommand {
  constructor(public readonly payload: IAddBlocksBatchCommand) {}
}
