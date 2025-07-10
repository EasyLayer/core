import type { Filter, PaginationDto } from './interfaces';

export interface IFetchEventsQuery {
  readonly modelIds: string[];
  readonly filter: Filter;
  readonly paging: PaginationDto;
  readonly streaming?: boolean;
}

export class FetchEventsQuery {
  constructor(public readonly payload: IFetchEventsQuery) {}
}
