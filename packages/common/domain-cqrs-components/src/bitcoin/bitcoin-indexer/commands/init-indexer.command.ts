export interface IInitIndexerCommand {
  requestId: string;
  indexedHeight: number;
}

export class InitIndexerCommand {
  constructor(public readonly payload: IInitIndexerCommand) {}
}
