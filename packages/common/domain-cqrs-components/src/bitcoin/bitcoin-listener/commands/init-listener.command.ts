export interface IInitListenerCommand {
  requestId: string;
  indexedHeight: number;
}

export class InitListenerCommand {
  constructor(public readonly payload: IInitListenerCommand) {}
}
