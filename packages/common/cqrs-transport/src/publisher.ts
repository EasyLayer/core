import { Subject } from 'rxjs';
import { Injectable, Inject } from '@nestjs/common';
import { AppLogger } from '@easylayer/common/logger';
import { DomainEvent, IEventPublisher, setEventMetadata } from '@easylayer/common/cqrs';
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
   * Create a DomainEvent instance from a wire record.
   *
   * Important bits:
   * - We create a tiny "constructor" object whose name equals the event type (class name).
   * - We **stamp NestJS EVENT_METADATA** on that constructor: { id: <type-name> }.
   *   This makes the event discoverable by Nest CQRS internals & by our CustomEventBus.
   * - This happens **only** for whitelisted (system) events.
   */
  private createDomainEventFromWire(wireEvent: WireEventRecord): DomainEvent {
    const body = JSON.parse(wireEvent.payload);

    // Synthetic constructor “holder” whose name matches the wire event type.
    // We attach EVENT_METADATA to it so CQRS filtering by id keeps working.
    const ctor: any = { name: wireEvent.eventType };
    setEventMetadata(ctor as any);

    // Build a plain event object with OWN 'payload' property (no prototype tricks).
    const event: DomainEvent = {
      aggregateId: wireEvent.modelName,
      requestId: wireEvent.requestId,
      blockHeight: wireEvent.blockHeight,
      timestamp: wireEvent.timestamp,
      payload: body, // parsed JSON body as a normal field
    };

    // Ensure event.constructor.name === wireEvent.eventType for ofType()/metadata routes,
    // but do NOT put payload on the prototype. Make it non-enumerable to avoid leaking in JSON.
    Object.defineProperty(event, 'constructor', {
      value: ctor,
      writable: false,
      enumerable: false,
      configurable: true,
    });

    return event;
  }
}
