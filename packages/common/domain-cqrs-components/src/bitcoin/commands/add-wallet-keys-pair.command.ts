export interface IAddWalletKeysPairCommand {
  requestId: string;
  mnemonic?: string;
  seed?: string;
  privateKey?: string;
}

export class AddWalletKeysPairCommand {
  constructor(public readonly payload: IAddWalletKeysPairCommand) {}
}
