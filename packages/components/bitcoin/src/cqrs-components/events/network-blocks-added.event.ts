import { SystemEvent, BasicEvent, EventBasePayload } from '@easylayer/common/cqrs';
import { LightBlock } from '../../blockchain-provider';

export interface BitcoinNetworkBlocksAddedEventPayload extends EventBasePayload {
  blocks: LightBlock[];
}

@SystemEvent()
export class BitcoinNetworkBlocksAddedEvent extends BasicEvent<BitcoinNetworkBlocksAddedEventPayload> {}
