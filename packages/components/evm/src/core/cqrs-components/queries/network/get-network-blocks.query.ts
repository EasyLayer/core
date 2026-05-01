import { IsBoolean, IsNumber, IsOptional, IsPositive } from 'class-validator';
import { JSONSchema } from 'class-validator-jsonschema';
import { QueryDoc } from '@easylayer/common/shared-interfaces';

export interface IGetNetworkBlocksQuery {
  readonly lastN?: number;
  readonly all?: boolean;
}

export class GetNetworkBlocksQueryDto {
  @IsOptional()
  @IsNumber()
  @IsPositive()
  @JSONSchema({ description: 'Number of recent EVM blocks to retrieve', default: 10, example: 10, minimum: 1 })
  lastN?: number;

  @IsOptional()
  @IsBoolean()
  @JSONSchema({ description: 'Retrieve all currently stored light blocks', default: false, example: false })
  all?: boolean;
}

@QueryDoc({ description: 'Retrieves multiple EVM light blocks from the Network aggregate', category: 'Network' })
export class GetNetworkBlocksQuery {
  constructor(public readonly payload: IGetNetworkBlocksQuery) {}
}
