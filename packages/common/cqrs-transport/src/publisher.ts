import { Subject } from 'rxjs';
import { Injectable, Inject } from '@nestjs/common';
import { AppLogger } from '@easylayer/common/logger';
import { DomainEvent, IEventPublisher } from '@easylayer/common/cqrs';
import { ProducersManager } from '@easylayer/common/network-transport';
import { WireEventRecord } from './event-record.interface';

@Injectable()
export class Publisher implements IEventPublisher<DomainEvent> {
  /** Local subscribers receive only parsed SYSTEM events. */
  private subject$ = new Subject<DomainEvent>();
  private systemModelNamesSet: Set<string>;

  constructor(
    @Inject(ProducersManager)
    private readonly producersManager: ProducersManager,
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
    await this.producersManager.streamWireWithAck(events);

    // Emit system events locally after ACK
    this.emitSystemEventsLocally(events);
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
        const body = JSON.parse(wireEvent.payload);

        // Create domain event from wire event
        const domainEvent: DomainEvent = this.createDomainEventFromWire(wireEvent, body);

        this.subject$.next(domainEvent);
      } catch (error) {
        this.log.debug('Failed to parse system event payload', {
          args: {
            modelName: wireEvent.modelName,
            eventType: wireEvent.eventType,
            error: (error as any)?.message,
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

  /**
   * Create domain event object from wire event
   */
  private createDomainEventFromWire(wireEvent: WireEventRecord, body: any): DomainEvent {
    // Create prototype with constructor name
    const proto: any = { payload: body };
    proto.constructor = { name: wireEvent.eventType } as any;

    // Create domain event with all properties
    const domainEvent: DomainEvent = Object.assign(Object.create(proto), {
      aggregateId: wireEvent.modelName,
      requestId: wireEvent.requestId,
      blockHeight: wireEvent.blockHeight,
      version: wireEvent.eventVersion,
      timestamp: wireEvent.timestamp,
    });

    return domainEvent;
  }
}
