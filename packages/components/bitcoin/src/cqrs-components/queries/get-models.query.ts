import type { Filter } from './interfaces';

export interface IGetModelsQuery {
  readonly modelIds: string[];
  readonly filter: Filter;
}

export class GetModelsQuery {
  constructor(public readonly payload: IGetModelsQuery) {}
}
