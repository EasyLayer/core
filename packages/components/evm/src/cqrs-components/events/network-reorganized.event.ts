import { BasicEvent } from '@easylayer/common/cqrs';
import type { LightBlock } from '../../blockchain-provider';

interface EvmNetworkReorganizedEventPayload {
  blocks: LightBlock[];
}

export class EvmNetworkReorganizedEvent extends BasicEvent<EvmNetworkReorganizedEventPayload> {}
