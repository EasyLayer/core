import { BasicEvent } from '@easylayer/common/cqrs';
import type { LightBlock } from '../../../blockchain-provider/components/block.interfaces';

export interface EvmNetworkReorganizedEventPayload {
  blocks: LightBlock[];
}

export class EvmNetworkReorganizedEvent extends BasicEvent<EvmNetworkReorganizedEventPayload> {}
