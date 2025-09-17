import { BasicEvent } from '@easylayer/common/cqrs';

interface BitcoinNetworkInitializedEventPayload {}

export class BitcoinNetworkInitializedEvent extends BasicEvent<BitcoinNetworkInitializedEventPayload> {}
