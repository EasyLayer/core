export interface Filter {
  blockHeight?: number;
  version?: number;
  status?: string;
}

export class PaginationDto {
  readonly limit?: number;
  readonly offset?: number;
}
