import type { LightBlock } from '@easylayer/bitcoin';

export interface IProcessMempoolReorganisationCommand {
  requestId: string;
  blocks: LightBlock[];
}

export class ProcessMempoolReorganisationCommand {
  constructor(public readonly payload: IProcessMempoolReorganisationCommand) {}
}
