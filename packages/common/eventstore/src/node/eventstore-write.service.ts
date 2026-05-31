import { Injectable, OnModuleDestroy, OnModuleInit, Logger } from '@nestjs/common';
import { ExponentialTimer, exponentialIntervalAsync } from '@easylayer/common/exponential-interval-async';
import type { AggregateRoot } from '@easylayer/common/cqrs';
import { PublisherProvider } from '@easylayer/common/cqrs-transport';
import { assertFullOutboxAck, type BaseAdapter } from '../core/base-adapter';
import { OutboxDeliveryCoordinator, type OutboxDeliveryRunContext } from '../core/outbox-delivery-coordinator';
import { EventStoreReadService } from './eventstore-read.service';

/**
 * Public service configuration.
 * NOTE: chunk sizing is adapter-owned; the service passes only the transport ceiling.
 */
export interface EventStoreConfiguration {
  /** Hard cap per transport frame (e.g., gRPC/HTTP limit). */
  transportMaxFrameBytes?: number;
  /**
   * Global prune flag — set once at module init from crawler config.
   * All models share the same SQLite files, so pruning must be all-or-nothing.
   * Default: false.
   */
  allowPruning?: boolean;
}

/**
 * Options for EventStoreWriteService.save().
 */
export interface SaveOptions {
  /**
   * The highest block height that is considered irreversible (finalized) by the crawler.
   * When provided, and a snapshot exists at a height <= irreversibleHeight, the SQLite
   * adapter will rotate the active file (directory mode only).
   * Postgres and browser adapters ignore this value.
   */
  irreversibleHeight?: number;
}

@Injectable()
export class EventStoreWriteService<T extends AggregateRoot = AggregateRoot> implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventStoreWriteService.name);

  private retryTimer: ExponentialTimer | null = null;

  // Default 10 MB — must match transport-sdk maxWireBytes and SDK client maxWireBytes.
  // Bitcoin block events can reach 2–4 MB serialized; 1 MB caused permanent outbox stall.
  private transportMaxFrameBytes = 10 * 1024 * 1024;
  private allowPruning = false;

  private readonly outboxDelivery = new OutboxDeliveryCoordinator((event) => {
    const args: Record<string, unknown> = {
      flowId: event.flowId,
      source: event.source,
      phase: event.phase,
    };
    if (event.queueWaitMs !== undefined) args.queueWaitMs = event.queueWaitMs;
    if (event.durationMs !== undefined) args.durationMs = event.durationMs;
    if (event.error !== undefined) args.error = (event.error as any)?.message ?? String(event.error);

    this.logger.verbose('Outbox delivery flow state changed', {
      module: 'eventstore',
      args,
    });
  });

  private draining: Promise<{ completed: boolean }> | null = null;
  private readonly activeSaves = new Set<Promise<void>>();

  // True while the serialized outbox drain is in exponential retry after a transport failure.
  // The outbox table remains the only remote delivery source; this flag only records retry state.
  private drainFailing = false;

  constructor(
    private readonly adapter: BaseAdapter<T>,
    private readonly publisherProvider: PublisherProvider,
    private readonly eventStoreReadService: EventStoreReadService,
    config: any
  ) {
    if (config?.transportMaxFrameBytes !== undefined) this.transportMaxFrameBytes = config.transportMaxFrameBytes;
    if (config?.allowPruning !== undefined) this.allowPruning = config.allowPruning;
  }

  async onModuleInit(): Promise<void> {
    if (!this.hasRemoteTransport()) {
      this.logger.verbose('Startup outbox drain skipped: no remote transport configured', {
        module: 'eventstore',
      });
      return;
    }

    this.logger.verbose('Startup outbox drain started', { module: 'eventstore' });
    await this.runDrainOnce('startup-drain');
  }

  async onModuleDestroy(): Promise<void> {
    this.retryTimer?.destroy();
    this.retryTimer = null;
    this.logger.verbose('EventStore write service is waiting for active outbox delivery before shutdown', {
      module: 'eventstore',
      args: { action: 'onModuleDestroy' },
    });
    await this.waitForActiveSaves();
    await this.outboxDelivery.waitForIdle();
    this.logger.verbose('EventStore write service outbox delivery is idle, shutdown can continue', {
      module: 'eventstore',
      args: { action: 'onModuleDestroy' },
    });
  }

  private async waitForActiveSaves(): Promise<void> {
    while (this.activeSaves.size > 0) {
      await Promise.allSettled(Array.from(this.activeSaves));
    }
  }

  private hasRemoteTransport(): boolean {
    return this.publisherProvider.publisher.hasRemoteTransport();
  }

  private async runDrainOnce(source = 'drain'): Promise<{ completed: boolean }> {
    return await this.outboxDelivery.run(source, (ctx) => this.runDrainOnceUnlocked(ctx));
  }

  private async runDrainOnceUnlocked(ctx: OutboxDeliveryRunContext): Promise<{ completed: boolean }> {
    if (this.draining) {
      return await this.draining;
    }

    this.draining = (async () => {
      try {
        return await this.drainOutboxCompletelyUnlocked(ctx);
      } finally {
        this.draining = null;
      }
    })();

    return await this.draining;
  }

  /**
   * Persist aggregate events + outbox rows, then drain the outbox table as the only remote delivery source.
   * Aggregate writes are always atomic. Outbox writes are included in the same transaction only when remote transport is configured.
   */
  public async save(models: T | T[], options: SaveOptions = {}): Promise<void> {
    const op = this.saveUnlocked(models, options);
    this.activeSaves.add(op);
    try {
      await op;
    } finally {
      this.activeSaves.delete(op);
    }
  }

  private async saveUnlocked(models: T | T[], options: SaveOptions = {}): Promise<void> {
    const aggregates = Array.isArray(models) ? models : [models];

    const writeOutbox = this.hasRemoteTransport();

    // One DB transaction that writes aggregate tables and, only when remote transport
    // is configured, matching outbox rows for external delivery.
    const persisted = await this.adapter.persistAggregatesAndOutbox(aggregates, { writeOutbox });

    this.logger.debug('Aggregates saved to event store', {
      module: 'eventstore',
      args: { aggregates: aggregates.length },
    });

    // Refresh read cache; maybe create persisted snapshot if aggregate says it's time.
    for (const a of aggregates) {
      if (a.aggregateId) {
        this.eventStoreReadService.cache.set(a.aggregateId, a);
        await this.maybeCreateSnapshot(a, options.irreversibleHeight);
      }
    }

    if (writeOutbox) {
      // Remote delivery has exactly one source of truth: the persisted outbox table.
      // Do not publish persisted.rawEvents directly from memory. A concurrent save can
      // drain those same rows from the outbox before this save reaches delivery, and
      // a memory fast-path would then redeliver the same WireEventRecords.
      await this.runDrainOnce('save-drain');
    }

    // Local system events are part of the current committed save and must be
    // emitted exactly once here. Remote outbox retry/drain is separate and must
    // not re-emit old outbox rows locally. When no remote transport is configured,
    // adapters do not write outbox rows at all and local processing continues here.
    this.publisherProvider.publisher.publishSystemEventsLocally(persisted.rawEvents);
  }

  // ───────────────────────────── ROLLBACK / REHYDRATE ─────────────────────────────

  public async rollback({
    modelsToRollback,
    blockHeight,
    modelsToSave,
  }: {
    modelsToRollback: T[];
    blockHeight: number;
    modelsToSave?: T[];
  }): Promise<void> {
    const ids = modelsToRollback.map((m) => m.aggregateId).filter(Boolean) as string[];

    if (ids.length > 0) {
      for (const id of ids) this.eventStoreReadService.cache.del(id);
      await this.adapter.rollbackAggregates(ids, blockHeight);
      this.logger.debug('Aggregates rolled back', {
        module: 'eventstore',
        args: { aggregateIds: ids, blockHeight },
      });
    }

    if (modelsToSave?.length) {
      await this.save(modelsToSave);
    }
  }

  // ───────────────────────────── OUTBOX DRAIN ─────────────────────────────

  private logOutboxChunkDiagnostic(
    phase: 'selected' | 'delete-started' | 'delete-committed' | 'watermark-advanced',
    ctx: OutboxDeliveryRunContext,
    event: { chunk: any; deleteMs?: number; watermarkBefore?: string; watermarkAfter?: string }
  ): void {
    this.logger.verbose('Outbox drain chunk state changed', {
      module: 'eventstore',
      args: {
        action: 'drainOutboxCompletely',
        flowId: ctx.flowId,
        source: ctx.source,
        phase,
        eventCount: event.chunk.eventCount,
        firstOutboxId: event.chunk.firstOutboxId,
        lastOutboxId: event.chunk.lastOutboxId,
        firstAggregateId: event.chunk.firstAggregateId,
        lastAggregateId: event.chunk.lastAggregateId,
        firstEventType: event.chunk.firstEventType,
        lastEventType: event.chunk.lastEventType,
        firstEventVersion: event.chunk.firstEventVersion,
        lastEventVersion: event.chunk.lastEventVersion,
        firstRequestId: event.chunk.firstRequestId,
        lastRequestId: event.chunk.lastRequestId,
        firstBlockHeight: event.chunk.firstBlockHeight,
        lastBlockHeight: event.chunk.lastBlockHeight,
        distinctAggregateIds: event.chunk.distinctAggregateIds,
        distinctEventTypes: event.chunk.distinctEventTypes,
        outboxIds: event.chunk.outboxIds,
        deleteMs: event.deleteMs,
        watermarkBefore: event.watermarkBefore,
        watermarkAfter: event.watermarkAfter,
      },
    });
  }

  /**
   * Drains the outbox in multiple chunks. ACK policy: one ACK per chunk.
   * Chunk sizing and EMA hints are adapter-owned; service gives only the transport cap.
   */
  private async drainOutboxCompletelyUnlocked(ctx: OutboxDeliveryRunContext): Promise<{ completed: boolean }> {
    if (!this.hasRemoteTransport()) return { completed: true };

    while (true) {
      try {
        const sent = await this.adapter.fetchDeliverAckChunk(
          this.transportMaxFrameBytes,
          async (events) => {
            const drainStartedAt = Date.now();
            this.logger.verbose('Outbox drain chunk publish started', {
              module: 'eventstore',
              args: {
                action: 'drainOutboxCompletely',
                flowId: ctx.flowId,
                source: ctx.source,
                eventCount: events.length,
                firstModelName: events[0]?.modelName,
                lastModelName: events[events.length - 1]?.modelName,
                firstEventType: events[0]?.eventType,
                lastEventType: events[events.length - 1]?.eventType,
                firstEventVersion: events[0]?.eventVersion,
                lastEventVersion: events[events.length - 1]?.eventVersion,
                firstRequestId: events[0]?.requestId,
                lastRequestId: events[events.length - 1]?.requestId,
                firstBlockHeight: events[0]?.blockHeight,
                lastBlockHeight: events[events.length - 1]?.blockHeight,
              },
            });
            const ack = await this.publisherProvider.publisher.publishWireStreamBatchWithAck(events);
            assertFullOutboxAck(ack, events.length);
            this.logger.verbose('Outbox drain chunk ACK received', {
              module: 'eventstore',
              args: {
                action: 'drainOutboxCompletely',
                flowId: ctx.flowId,
                source: ctx.source,
                eventCount: events.length,
                correlationId: ack.correlationId,
                okIndices: ack.okIndices,
                ackMs: Date.now() - drainStartedAt,
              },
            });
            return ack;
          },
          (event) => this.logOutboxChunkDiagnostic(event.phase, ctx, event)
        );
        if (sent === 0) return { completed: true };
      } catch (e) {
        this.logger.verbose('Outbox drain chunk failed', {
          module: 'eventstore',
          args: { action: 'drainOutboxCompletely', flowId: ctx.flowId, source: ctx.source, error: (e as any)?.message },
        });
        this.startRetryTimerIfNeeded();
        return { completed: false };
      }
    }
  }

  private startRetryTimerIfNeeded(): void {
    if (this.retryTimer) return;
    this.drainFailing = true;
    this.logger.verbose('Outbox retry timer started', {
      module: 'eventstore',
      args: { action: 'startRetryTimerIfNeeded' },
    });
    this.retryTimer = exponentialIntervalAsync(
      async (reset) => {
        try {
          const result = await this.runDrainOnce('retry-drain');
          if (!result.completed) return;

          reset();
          this.drainFailing = false; // Clear flag once drain succeeds
          this.retryTimer?.destroy();
          this.retryTimer = null;
          this.logger.verbose('Outbox retry timer cleared, drain succeeded', {
            module: 'eventstore',
            args: { action: 'retryTimer' },
          });
        } catch {
          // keep retrying
        }
      },
      { interval: 1000, multiplier: 2, maxInterval: 8000 }
    );
  }

  // ───────────────────────────── READ API (cached) ─────────────────────────────

  /** Create a snapshot for a single aggregate if it says it’s time. (kept) */
  public async maybeCreateSnapshot(aggregate: T, irreversibleHeight?: number): Promise<void> {
    if (!aggregate.canMakeSnapshot()) return;

    const { minKeep, keepWindow } = aggregate.getSnapshotRetention();
    try {
      await this.adapter.createSnapshot(
        aggregate,
        { minKeep, keepWindow, allowPruning: this.allowPruning },
        irreversibleHeight
      );
      // Snapshot successfully created → reset the counter on the aggregate
      aggregate.resetSnapshotCounter();
    } catch (err: any) {
      // Snapshot errors are swallowed by policy — never fail the main save flow.
      this.logger.verbose('Snapshot create failed (swallowed by policy)', {
        module: 'eventstore',
        args: { action: 'maybeCreateSnapshot', aggregateId: aggregate.aggregateId, error: err?.message },
      });
    }
  }
}
