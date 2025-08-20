import { SystemEvent, BasicEvent } from '@easylayer/common/cqrs';
import { LightBlock } from '../../blockchain-provider';

export interface EvmNetworkBlocksAddedEventPayload {
  blocks: LightBlock[];
}

@SystemEvent()
export class EvmNetworkBlocksAddedEvent extends BasicEvent<EvmNetworkBlocksAddedEventPayload> {}
