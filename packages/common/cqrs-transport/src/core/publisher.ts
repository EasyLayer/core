import { Subject } from 'rxjs';
import type { Logger } from '@nestjs/common';
import type { DomainEvent } from '@easylayer/common/cqrs';
import type { OutboxStreamManager } from '@easylayer/common/network-transport';
import type { WireEventRecord } from './event-record.interface';

export class Publisher {
  private subject$ = new Subject<DomainEvent>();
  private systemModelNamesSet: Set<string>;

  constructor(
    private readonly outboxStreamManager: OutboxStreamManager,
    private readonly log: Logger,
    systemModelNames: string[]
  ) {
    this.systemModelNamesSet = new Set(systemModelNames ?? []);
  }

  get events$() {
    return this.subject$.asObservable();
  }

  async publishWire(event: WireEventRecord): Promise<void> {
    await this.publishWireStreamBatchWithAck([event]);
  }

  async publishWireStreamBatchWithAck(events: WireEventRecord[]): Promise<void> {
    if (!events.length) return;
    await this.outboxStreamManager.streamWireWithAck(events);
    queueMicrotask(() => this.emitSystemEventsLocally(events));
  }

  private emitSystemEventsLocally(events: WireEventRecord[]): void {
    for (const wireEvent of events) {
      if (!this.isSystemEvent(wireEvent)) continue;
      try {
        const domainEvent: DomainEvent = this.createDomainEventFromWire(wireEvent);
        this.subject$.next(domainEvent);
      } catch (error) {
        this.log.debug('Failed to parse system event payload', {
          args: {
            modelName: wireEvent.modelName,
            eventType: wireEvent.eventType,
            err: (error as any)?.message,
          },
        });
      }
    }
  }

  /**
   * Check if wireEvent is from a system model
   */
  private isSystemEvent(wireEvent: WireEventRecord): boolean {
    return this.systemModelNamesSet.has(wireEvent.modelName);
  }

  private createDomainEventFromWire(wireEvent: WireEventRecord): DomainEvent {
    const body = JSON.parse(wireEvent.payload);

    const EventCtor: any = function () {};
    Object.defineProperty(EventCtor, 'name', { value: wireEvent.eventType, configurable: true });
    // setEventMetadata(EventCtor as any);

    const event: DomainEvent = {
      aggregateId: wireEvent.modelName,
      requestId: wireEvent.requestId,
      blockHeight: wireEvent.blockHeight,
      timestamp: wireEvent.timestamp,
      payload: body,
    };

    const instance = Object.assign(Object.create(EventCtor.prototype), event);
    Object.defineProperty(instance, 'constructor', { value: EventCtor, writable: false, enumerable: false });

    return instance;
  }
}
