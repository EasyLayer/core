import { IsOptional, IsString, IsNumber, IsPositive, Min } from 'class-validator';
import { JSONSchema } from 'class-validator-jsonschema';
export interface Filter {
  blockHeight?: number;
  version?: number;
  status?: string;
}

export class FilterDto {
  @IsOptional()
  @IsNumber()
  @JSONSchema({
    description: 'Filter events by block height',
    example: 100,
  })
  blockHeight?: number;

  @IsOptional()
  @IsNumber()
  @JSONSchema({
    description: 'Filter events by version number',
    example: 5,
  })
  version?: number;

  @IsOptional()
  @IsString()
  @JSONSchema({
    description: 'Filter events by status',
    example: 'PUBLISHED',
  })
  status?: string;
}

export class PaginationDto {
  @IsOptional()
  @IsNumber()
  @IsPositive()
  @JSONSchema({
    description: 'Number of items to return',
    default: 10,
    example: 10,
    minimum: 1,
    maximum: 1000,
  })
  readonly limit?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @JSONSchema({
    description: 'Number of items to skip',
    default: 0,
    example: 0,
    minimum: 0,
  })
  readonly offset?: number;
}
