import type { Filter, PaginationDto } from './interfaces';

export interface IFetchEventsQuery {
  readonly modelIds: string[];
  readonly filter: Filter;
  readonly paging: PaginationDto;
}

export class FetchEventsQuery {
  constructor(public readonly payload: IFetchEventsQuery) {}
}
