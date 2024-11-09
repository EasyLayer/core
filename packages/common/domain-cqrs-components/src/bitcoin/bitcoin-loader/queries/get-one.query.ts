export interface IGetOneQuery {
  readonly entityName: string;
  readonly filter: any;
  readonly relations?: string[];
}

export class GetOneQuery {
  constructor(public readonly payload: IGetOneQuery) {}
}
