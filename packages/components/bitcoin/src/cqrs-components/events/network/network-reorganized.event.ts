import { SystemEvent, BasicEvent } from '@easylayer/common/cqrs';
import { LightBlock } from '../../../blockchain-provider';

interface BitcoinNetworkReorganizedEventPayload {
  blocks: LightBlock[];
}

@SystemEvent()
export class BitcoinNetworkReorganizedEvent extends BasicEvent<BitcoinNetworkReorganizedEventPayload> {}
