export interface IProcessMempoolReorganisationCommand {
  requestId: string;
  blocks: Array<{ height: number; hash: string }>;
}

export class ProcessMempoolReorganisationCommand {
  constructor(public readonly payload: IProcessMempoolReorganisationCommand) {}
}
