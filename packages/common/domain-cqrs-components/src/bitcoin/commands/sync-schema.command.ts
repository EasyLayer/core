export interface ISyncSchemaCommand {
  requestId: string;
}

export class SyncSchemaCommand {
  constructor(public readonly payload: ISyncSchemaCommand) {}
}
