export interface IGetAnyQuery {
  readonly prefix: string;
  readonly coditions?: any;
  readonly relations?: any;
}

export class GetAnyQuery {
  constructor(public readonly payload: IGetAnyQuery) {}
}
