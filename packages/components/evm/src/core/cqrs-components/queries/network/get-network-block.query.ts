import { IsNumber, Min } from 'class-validator';
import { JSONSchema } from 'class-validator-jsonschema';
import { QueryDoc } from '@easylayer/common/shared-interfaces';

export interface IGetNetworkBlockQuery {
  readonly height: number;
}

export class GetNetworkBlockQueryDto {
  @IsNumber()
  @Min(0)
  @JSONSchema({ description: 'EVM block number to retrieve', example: 19000000, minimum: 0 })
  height!: number;
}

@QueryDoc({
  description: 'Retrieves a specific EVM block from the Network aggregate by block number',
  category: 'Network',
})
export class GetNetworkBlockQuery {
  constructor(public readonly payload: IGetNetworkBlockQuery) {}
}
