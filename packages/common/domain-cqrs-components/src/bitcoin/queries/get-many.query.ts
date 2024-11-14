export interface IGetManyQuery {
  readonly entityName: string;
  readonly filter?: any;
  readonly sorting?: any;
  readonly paging?: any;
  readonly relations?: string[];
}

export class GetManyQuery {
  constructor(public readonly payload: IGetManyQuery) {}
}
