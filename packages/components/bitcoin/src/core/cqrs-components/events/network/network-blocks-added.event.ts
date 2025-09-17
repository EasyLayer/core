import { BasicEvent } from '@easylayer/common/cqrs';
import type { LightBlock } from '../../../blockchain-provider';

export interface BitcoinNetworkBlocksAddedEventPayload {
  blocks: LightBlock[];
}

export class BitcoinNetworkBlocksAddedEvent extends BasicEvent<BitcoinNetworkBlocksAddedEventPayload> {}
