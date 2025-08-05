import type { LightBlock } from '@easylayer/bitcoin';

export interface IProcessMempoolBlocksBatchCommand {
  requestId: string;
  blocks: LightBlock[];
}

export class ProcessMempoolBlocksBatchCommand {
  constructor(public readonly payload: IProcessMempoolBlocksBatchCommand) {}
}
