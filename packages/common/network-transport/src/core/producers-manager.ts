import type { BasicEvent, EventBasePayload } from '@easylayer/common/cqrs';
import type { AppLogger } from '@easylayer/common/logger';
import type { BaseProducer } from './base-producer';
import type { OutgoingMessage } from '../shared';
import { ClientNotFoundError } from '../shared';

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
   * Add a producer to the manager
   */
  public addProducer(producer: BaseProducer<OutgoingMessage>): void {
    this._producers.push(producer);
    this.log.debug(`Added producer: ${producer.transportType}`);
  }

  /**
   * Remove a producer from the manager
   */
  public removeProducer(producer: BaseProducer<OutgoingMessage>): void {
    const index = this._producers.indexOf(producer);
    if (index !== -1) {
      this._producers.splice(index, 1);
      this.log.debug(`Removed producer: ${producer.transportType}`);
    }
  }

  /**
   * Broadcasts an array of CQRS events to all configured producers in parallel.
   */
  public async broadcast<T extends BasicEvent<EventBasePayload>>(events: T[]) {
    if (this._producers.length === 0) {
      this.log.debug('No producers to broadcast');
      return;
    }

    if (events.length === 0) {
      this.log.debug('No events to broadcast');
      return;
    }

    this.log.debug('Starting broadcast of events', {
      args: { count: events.length, producers: this._producers.length },
    });

    const message: OutgoingMessage<'eventsBatch', { constructorName: string; dto: any }[]> = {
      action: 'eventsBatch',
      payload: events.map((event) => ({
        constructorName: Object.getPrototypeOf(event).constructor.name,
        dto: event,
      })),
      timestamp: Date.now(),
    };

    const connectedProducers = this._producers.filter((p) => p.isConnected());

    if (connectedProducers.length === 0) {
      this.log.warn('No connected producers available for broadcast');
      return;
    }

    const results = await Promise.allSettled(
      connectedProducers.map((producer) =>
        producer.sendMessage(message).catch((error) => {
          this.log.error(`Producer ${producer.transportType} failed to send batch`, { args: { error } });
          throw error;
        })
      )
    );

    const successful = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.filter((r) => r.status === 'rejected').length;

    this.log.debug('Broadcast completed', {
      args: {
        eventCount: events.length,
        totalProducers: this._producers.length,
        connectedProducers: connectedProducers.length,
        successful,
        failed,
      },
    });

    if (failed > 0) {
      this.log.warn(`${failed} producers failed during broadcast`);
    }
  }

  /**
   * Send a single event to all transports
   */
  public async sendEvent<T extends BasicEvent<EventBasePayload>>(event: T) {
    this.log.debug('Sending single event', {
      args: { eventType: Object.getPrototypeOf(event).constructor.name },
    });

    const message: OutgoingMessage<'event', { constructorName: string; dto: any }> = {
      action: 'event',
      payload: {
        constructorName: Object.getPrototypeOf(event).constructor.name,
        dto: event,
      },
      timestamp: Date.now(),
    };

    const connectedProducers = this._producers.filter((p) => p.isConnected());

    if (connectedProducers.length === 0) {
      throw new ClientNotFoundError('No connected producers available');
    }

    const results = await Promise.allSettled(
      connectedProducers.map((producer) =>
        producer.sendMessage(message).catch((error) => {
          this.log.error(`Producer ${producer.transportType} failed to send event`, { args: { error } });
          throw error;
        })
      )
    );

    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed > 0) {
      this.log.warn(`${failed} producers failed to send event`);
    }
  }

  /**
   * Send ping to all connected producers
   */
  public async sendPingToAll(): Promise<void> {
    const connectedProducers = this._producers.filter((p) => p.isConnected());

    if (connectedProducers.length === 0) {
      throw new ClientNotFoundError('No connected producers available for ping');
    }

    const results = await Promise.allSettled(
      connectedProducers.map(async (producer) => {
        if (producer.sendPing) {
          await producer.sendPing();
        }
      })
    );

    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed > 0) {
      this.log.warn(`${failed} producers failed to send ping`);
    }
  }

  /**
   * Get status of all producers
   */
  public getProducersStatus(): Array<{ name: string; connected: boolean }> {
    return this._producers.map((producer) => ({
      name: producer.transportType,
      connected: producer.isConnected(),
    }));
  }

  /**
   * Get count of connected producers
   */
  public getConnectedCount(): number {
    return this._producers.filter((p) => p.isConnected()).length;
  }

  /**
   * Get count of total producers
   */
  public getTotalCount(): number {
    return this._producers.length;
  }

  /**
   * Check if any producers are connected
   */
  public hasConnectedProducers(): boolean {
    return this.getConnectedCount() > 0;
  }
}
