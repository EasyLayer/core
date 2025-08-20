import { SystemEvent, BasicEvent } from '@easylayer/common/cqrs';
import { LightBlock } from '../../../blockchain-provider';

export interface BitcoinNetworkBlocksAddedEventPayload {
  blocks: LightBlock[];
}

@SystemEvent()
export class BitcoinNetworkBlocksAddedEvent extends BasicEvent<BitcoinNetworkBlocksAddedEventPayload> {}
