export interface IInitWalletCommand {
  requestId: string;
}

export class InitWalletCommand {
  constructor(public readonly payload: IInitWalletCommand) {}
}
