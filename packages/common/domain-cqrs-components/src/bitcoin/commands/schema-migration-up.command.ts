export interface ISchemaMigrationUpCommand {
  requestId: string;
  upQueries: any[];
}

export class SchemaMigrationUpCommand {
  constructor(public readonly payload: ISchemaMigrationUpCommand) {}
}
