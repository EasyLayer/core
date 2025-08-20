import { SystemEvent, BasicEvent } from '@easylayer/common/cqrs';
import { LightBlock } from '../../blockchain-provider';

interface EvmNetworkReorganizedEventPayload {
  blocks: LightBlock[];
}

@SystemEvent()
export class EvmNetworkReorganizedEvent extends BasicEvent<EvmNetworkReorganizedEventPayload> {}
