import { BasicEvent } from '@easylayer/common/cqrs';
import type { LightBlock } from '../../../blockchain-provider';

interface BitcoinNetworkReorganizedEventPayload {
  blocks: LightBlock[];
}

export class BitcoinNetworkReorganizedEvent extends BasicEvent<BitcoinNetworkReorganizedEventPayload> {}
