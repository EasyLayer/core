import type { LightBlock } from '../../blockchain-provider';

export interface IProcessMempoolReorganisationCommand {
  requestId: string;
  blocks: LightBlock[];
}

export class ProcessMempoolReorganisationCommand {
  constructor(public readonly payload: IProcessMempoolReorganisationCommand) {}
}
