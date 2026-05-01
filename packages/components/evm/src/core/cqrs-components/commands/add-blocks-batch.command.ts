import type { Block } from '../../blockchain-provider/components/block.interfaces';

export interface IAddBlocksBatchCommand {
  batch: Block[];
  requestId: string;
}

export class AddBlocksBatchCommand {
  constructor(public readonly payload: IAddBlocksBatchCommand) {}
}
