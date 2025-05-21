import { SystemEvent, BasicEvent, EventBasePayload } from '@easylayer/common/cqrs';
import { LightBlock } from '../../blockchain-provider';

export interface EvmNetworkBlocksAddedEventPayload extends EventBasePayload {
  blocks: LightBlock[];
}

@SystemEvent()
export class EvmNetworkBlocksAddedEvent extends BasicEvent<EvmNetworkBlocksAddedEventPayload> {}
