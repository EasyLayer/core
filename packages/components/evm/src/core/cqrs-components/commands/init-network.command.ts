export interface IInitNetworkCommand {
  requestId: string;
  indexedHeight: number;
}

export class InitNetworkCommand {
  constructor(public readonly payload: IInitNetworkCommand) {}
}
