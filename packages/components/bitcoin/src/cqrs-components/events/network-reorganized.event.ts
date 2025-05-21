import { SystemEvent, BasicEvent, EventBasePayload } from '@easylayer/common/cqrs';
import { LightBlock } from '../../blockchain-provider';

interface BitcoinNetworkReorganizedEventPayload extends EventBasePayload {
  blocks: LightBlock[];
}

@SystemEvent()
export class BitcoinNetworkReorganizedEvent extends BasicEvent<BitcoinNetworkReorganizedEventPayload> {}
