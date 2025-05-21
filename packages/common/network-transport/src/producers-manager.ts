import type { BasicEvent, EventBasePayload } from '@easylayer/common/cqrs';
import type { AppLogger } from '@easylayer/common/logger';
import type { BaseProducer } from './base-producer';
import type { OutgoingMessage } from './interfaces';

/**
 * Manages multiple producers to broadcast events across transports.
 */
export class ProducersManager {
  constructor(
    private readonly log: AppLogger,
    private _producers: BaseProducer<OutgoingMessage>[]
  ) {}

  public get producers(): BaseProducer<OutgoingMessage>[] {
    return this._producers;
  }

  /**
   * Broadcasts an array of CQRS events to all configured producers in parallel.
   * Emits debug logs before and after sending messages.
   *
   * @param events Array of event instances to broadcast.
   */
  public async broadcast<T extends BasicEvent<EventBasePayload>>(events: T[]) {
    this.log.debug('Starting broadcast of events', { args: { count: events.length } });

    const message: OutgoingMessage<'batch', { constructorName: string; dto: any }[]> = {
      action: 'batch',
      payload: events.map((event) => ({
        constructorName: Object.getPrototypeOf(event).constructor.name,
        dto: event,
      })),
    };
    this.log.debug('Constructed outgoing message', { args: { message } });

    await Promise.all(this.producers.map((p) => p.sendMessage(message)));
    this.log.debug('Broadcast completed successfully', { args: { count: events.length } });
  }
}
