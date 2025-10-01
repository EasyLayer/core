import { BasicEvent } from '@easylayer/common/cqrs';

interface BitcoinNetworkClearedEventPayload {}

export class BitcoinNetworkClearedEvent extends BasicEvent<BitcoinNetworkClearedEventPayload> {}
