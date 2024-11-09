export interface IAddKeysPairCommand {
  requestId: string;
  mnemonic?: string;
  seed?: string;
  privateKey?: string;
}

export class AddKeysPairCommand {
  constructor(public readonly payload: IAddKeysPairCommand) {}
}
