import type { LightBlock } from '../../blockchain-provider';

export interface IProcessMempoolBlocksBatchCommand {
  requestId: string;
  blocks: LightBlock[];
}

export class ProcessMempoolBlocksBatchCommand {
  constructor(public readonly payload: IProcessMempoolBlocksBatchCommand) {}
}
