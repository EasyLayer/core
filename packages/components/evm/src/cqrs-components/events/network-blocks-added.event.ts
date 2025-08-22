import { BasicEvent } from '@easylayer/common/cqrs';
import type { LightBlock } from '../../blockchain-provider';

export interface EvmNetworkBlocksAddedEventPayload {
  blocks: LightBlock[];
}

export class EvmNetworkBlocksAddedEvent extends BasicEvent<EvmNetworkBlocksAddedEventPayload> {}
