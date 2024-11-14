export interface IProcessReorganisationCommand {
  status: string;
  blocks: any[];
  height: string | number;
  requestId: string;
}

export class ProcessReorganisationCommand {
  constructor(public readonly payload: IProcessReorganisationCommand) {}
}
