import { BasicEvent } from '@easylayer/common/cqrs';
import type { LightBlock } from '../../../cqrs-components';

interface BitcoinNetworkReorganizedEventPayload {
  blocks: LightBlock[];
}

export class BitcoinNetworkReorganizedEvent extends BasicEvent<BitcoinNetworkReorganizedEventPayload> {}
