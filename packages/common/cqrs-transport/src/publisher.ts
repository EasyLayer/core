import { Subject } from 'rxjs';
import { Injectable, Inject } from '@nestjs/common';
import { AppLogger } from '@easylayer/common/logger';
import { DomainEvent, IEventPublisher, setEventMetadata } from '@easylayer/common/cqrs';
import { OutboxStreamManager } from '@easylayer/common/network-transport';
import { WireEventRecord } from './event-record.interface';

@Injectable()
export class Publisher implements IEventPublisher<DomainEvent> {
  /** Local subscribers receive only parsed SYSTEM events. */
  private subject$ = new Subject<DomainEvent>();
  private systemModelNamesSet: Set<string>;

  constructor(
    @Inject(OutboxStreamManager)
    private readonly outboxStreamManager: OutboxStreamManager,
    private readonly log: AppLogger,
    @Inject('SYSTEM_MODEL_NAMES')
    systemModelNames: string[]
  ) {
    this.systemModelNamesSet = new Set(systemModelNames);
  }

  get events$() {
    return this.subject$.asObservable();
  }

  /** Legacy CQRS interface compatibility (not used in the new path). */
  async publish<T extends DomainEvent>(_event: T): Promise<void> {
    throw new Error('Use publishWire for outbox-driven events.');
  }

  async publishAll<T extends DomainEvent>(_events: T[]): Promise<void> {
    throw new Error('Use publishWireStreamBatchWithAck for outbox-driven events.');
  }

  async publishWire<T extends WireEventRecord>(event: T): Promise<void> {
    await this.publishWireStreamBatchWithAck([event]);
  }

  async publishWireStreamBatchWithAck<T extends WireEventRecord>(events: T[]): Promise<void> {
    if (!events.length) return;

    // Stream with ACK to external transport
    await this.outboxStreamManager.streamWireWithAck(events);

    // Emit system events locally after ACK
    queueMicrotask(() => {
      this.emitSystemEventsLocally(events);
    });
  }

  /**
   * Parse and emit only system events to local subscribers
   */
  private emitSystemEventsLocally(events: WireEventRecord[]): void {
    for (const wireEvent of events) {
      if (!this.isSystemEvent(wireEvent)) {
        continue;
      }

      try {
        // Create domain event from wire event
        const domainEvent: DomainEvent = this.createDomainEventFromWire(wireEvent);

        this.subject$.next(domainEvent);
      } catch (error) {
        // this.log.debug('Failed to parse system event payload', {
        //   args: {
        //     modelName: wireEvent.modelName,
        //     eventType: wireEvent.eventType,
        //     error: (error as any)?.message,
        //   },
        // });
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
    setEventMetadata(EventCtor as any);

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
