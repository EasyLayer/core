export interface IInitSchemaCommand {
  requestId: string;
}

export class InitSchemaCommand {
  constructor(public readonly payload: IInitSchemaCommand) {}
}
