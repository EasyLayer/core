import { QueryDoc } from '@easylayer/common/shared-interfaces';

export interface IGetNetworkLastBlockQuery {}
export class GetNetworkLastBlockQueryDto {}

@QueryDoc({
  description: 'Retrieves the latest stored EVM light block from the Network aggregate',
  category: 'Network',
})
export class GetNetworkLastBlockQuery {
  constructor(public readonly payload: IGetNetworkLastBlockQuery) {}
}
