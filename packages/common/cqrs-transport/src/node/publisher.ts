import { Subject } from 'rxjs';
import type { Logger, OnModuleDestroy } from '@nestjs/common';
import type { DomainEvent } from '@easylayer/common/cqrs';
import type { OutboxBatchSender, OutboxStreamAckPayload } from '@easylayer/common/network-transport';
import type { WireEventRecord } from '../core/event-record.interface';

export class Publisher implements OnModuleDestroy {
  private readonly moduleName = 'cqrs-transport';
  private subject$ = new Subject<DomainEvent>();
  private systemModelNamesSet: Set<string>;

  constructor(
    private readonly outboxBatchSender: OutboxBatchSender,
    private readonly logger: Logger,
    systemModelNames: string[]
  ) {
    this.systemModelNamesSet = new Set(systemModelNames ?? []);
  }

  onModuleDestroy() {
    this.subject$.complete();
  }

  get events$() {
    return this.subject$.asObservable();
  }

  async publishWire(event: WireEventRecord): Promise<void> {
    await this.publishWireStreamBatchWithAck([event]);
  }

  hasRemoteTransport(): boolean {
    return this.outboxBatchSender.hasTransport();
  }

  /**
   * Emits system-model events into the local NestJS EventBus bridge.
   *
   * This is intentionally separate from remote outbox delivery. EventStore calls
   * it once for newly committed events. Outbox retry/drain paths must not call it,
   * otherwise an undelivered old outbox row can be re-emitted locally and block
   * crawler progress by replaying stale system events.
   */
  publishSystemEventsLocally(events: WireEventRecord[]): void {
    if (!events.length) return;

    // Stable array snapshot for the microtask boundary. This copies only the
    // array of references, not the event objects themselves.
    const batch = events.slice();
    queueMicrotask(() => this.emitSystemEventsLocally(batch));
  }

  /**
   * Sends a wire batch to the configured external transport and waits for ACK.
   *
   * This method does not emit local system events. Local EventBus propagation is
   * owned by EventStore's save path and must happen exactly once per newly
   * committed event, not during outbox retry/drain.
   */
  async publishWireStreamBatchWithAck(events: WireEventRecord[]): Promise<OutboxStreamAckPayload> {
    if (!events.length) return { ok: true, okIndices: [] };
    return await this.outboxBatchSender.streamWireWithAck(events);
  }

  private emitSystemEventsLocally(events: WireEventRecord[]): void {
    for (const wireEvent of events) {
      if (!this.isSystemEvent(wireEvent)) continue;
      try {
        const domainEvent: DomainEvent = this.createDomainEventFromWire(wireEvent);
        this.subject$.next(domainEvent);
      } catch (error) {
        this.logger.verbose('System event payload parse failed', {
          module: this.moduleName,
          args: {
            action: 'emitSystemEventsLocally',
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
