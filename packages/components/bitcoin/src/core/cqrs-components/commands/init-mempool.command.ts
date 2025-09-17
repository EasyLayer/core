export interface IInitMempoolCommand {
  requestId: string;
}

export class InitMempoolCommand {
  constructor(public readonly payload: IInitMempoolCommand) {}
}
