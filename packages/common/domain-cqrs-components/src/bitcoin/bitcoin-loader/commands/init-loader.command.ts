export interface IInitLoaderCommand {
  requestId: string;
  indexedHeight: number;
}

export class InitLoaderCommand {
  constructor(public readonly payload: IInitLoaderCommand) {}
}
