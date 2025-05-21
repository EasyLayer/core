import { SystemEvent, BasicEvent, EventBasePayload } from '@easylayer/common/cqrs';
import { LightBlock } from '../../blockchain-provider';

interface EvmNetworkReorganizedEventPayload extends EventBasePayload {
  blocks: LightBlock[];
}

@SystemEvent()
export class EvmNetworkReorganizedEvent extends BasicEvent<EvmNetworkReorganizedEventPayload> {}
