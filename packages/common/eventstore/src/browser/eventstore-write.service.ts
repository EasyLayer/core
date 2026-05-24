import { Injectable, OnModuleDestroy, OnModuleInit, Logger } from '@nestjs/common';
import { ExponentialTimer, exponentialIntervalAsync } from '@easylayer/common/exponential-interval-async';
import type { AggregateRoot } from '@easylayer/common/cqrs';
import { PublisherProvider, WireEventRecord } from '@easylayer/common/cqrs-transport';
import { assertFullOutboxAck, type BaseAdapter } from '../core/base-adapter';
import { EventStoreReadService } from './eventstore-read.service';

/**
 * Public service configuration.
 * NOTE: chunk sizing is adapter-owned; the service passes only the transport ceiling.
 */
export interface EventStoreConfiguration {
  /** Hard cap per transport frame (e.g., gRPC/HTTP limit). */
  transportMaxFrameBytes?: number;
}

@Injectable()
export class EventStoreWriteService<T extends AggregateRoot = AggregateRoot> implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventStoreWriteService.name);

  private retryTimer: ExponentialTimer | null = null;

  // Default 10 MB — must match transport-sdk maxWireBytes and SDK client maxWireBytes.
  // Bitcoin block events can reach 2–4 MB serialized; 1 MB caused permanent outbox stall.
  private transportMaxFrameBytes = 10 * 1024 * 1024;

  private draining: Promise<{ completed: boolean }> | null = null;

  // True while the drain is in exponential retry after a transport failure.
  // When set, save() skips the fast-path and delegates to the strict drain.
  private drainFailing = false;

  constructor(
    private readonly adapter: BaseAdapter<T>,
    private readonly publisherProvider: PublisherProvider,
    private readonly eventStoreReadService: EventStoreReadService,
    config: any
  ) {
    if (config?.transportMaxFrameBytes !== undefined) this.transportMaxFrameBytes = config.transportMaxFrameBytes;
  }

  async onModuleInit(): Promise<void> {
    if (!this.hasRemoteTransport()) {
      this.logger.verbose('Startup outbox drain skipped: no remote transport configured', {
        module: 'eventstore',
      });
      return;
    }

    this.logger.verbose('Startup outbox drain started', { module: 'eventstore' });
    await this.runDrainOnce();
  }

  onModuleDestroy(): void {
    this.retryTimer?.destroy();
    this.retryTimer = null;
  }

  private hasRemoteTransport(): boolean {
    return this.publisherProvider.publisher.hasRemoteTransport();
  }

  private async runDrainOnce(): Promise<{ completed: boolean }> {
    if (this.draining) {
      return await this.draining;
    }

    this.draining = (async () => {
      try {
        return await this.drainOutboxCompletely();
      } finally {
        this.draining = null;
      }
    })();

    return await this.draining;
  }

  /**
   * Persist → snapshot → optional remote publish (RAW fast-path if safe; otherwise strict outbox) → ACK.
   * Aggregate writes are always atomic. Outbox writes are included in the same transaction only when remote transport is configured.
   */
  public async save(models: T | T[]): Promise<void> {
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
        await this.maybeCreateSnapshot(a);
      }
    }

    if (writeOutbox) {
      // Deliver to the external transport using the correct outbox flow first.
      // Local system event emission can trigger follow-up saves (for example the
      // crawler loading the next block). Emitting before the current outbox row is
      // ACKed/deleted creates self-induced concurrency: the next save may see the
      // previous row as pending and force strict drain/retry, which can duplicate
      // live remote delivery.
      await this.publishWithCorrectFlow(persisted);
    }

    // Local system events are part of the current committed save and must be
    // emitted exactly once here. Remote outbox retry/drain is separate and must
    // not re-emit old outbox rows locally. When no remote transport is configured,
    // adapters do not write outbox rows at all and local processing continues here.
    this.publisherProvider.publisher.publishSystemEventsLocally(persisted.rawEvents);
  }

  /**
   * 1) If backlog exists before our first inserted row → strict drain (respect order).
   * 2) If anything appeared after current watermark (concurrency) → strict drain.
   * 3) Otherwise → RAW fast-path publish from memory, then ACK delete just inserted ids.
   */
  private async publishWithCorrectFlow(persisted: {
    insertedOutboxIds: string[];
    firstTs: number;
    firstId: string;
    lastTs: number;
    lastId: string;
    rawEvents: WireEventRecord[];
  }): Promise<void> {
    const backlogBefore = await this.adapter.hasBacklogBefore(persisted.firstTs, persisted.firstId);
    if (backlogBefore) {
      this.logger.verbose('Outbox backlog detected, falling back to strict drain', {
        module: 'eventstore',
        args: { firstId: persisted.firstId },
      });
      await this.runDrainOnce();
      return;
    }

    // If the drain is currently in retry (transport was recently unavailable),
    // skip the fast-path to avoid repeated failing publish attempts on every save().
    // The retry timer will clear drainFailing once a drain succeeds.
    if (this.drainFailing) {
      this.logger.verbose('Drain is in retry state, skipping fast-path publish', {
        module: 'eventstore',
      });
      await this.runDrainOnce();
      return;
    }

    const anyPending = await this.adapter.hasPendingAfterId(persisted.lastId);
    if (anyPending) {
      this.logger.verbose('Pending rows after watermark detected, falling back to strict drain', {
        module: 'eventstore',
      });
      await this.runDrainOnce();
      return;
    }

    if (persisted.rawEvents.length > 0) {
      // Step 1: publish. If transport is unavailable, outbox rows are retained and drain will retry.
      let published = false;
      try {
        const ack = await this.publisherProvider.publisher.publishWireStreamBatchWithAck(persisted.rawEvents);
        assertFullOutboxAck(ack, persisted.rawEvents.length);
        published = true;
      } catch (e) {
        this.logger.verbose('Fast-path publish failed, outbox retained for drain retry', {
          module: 'eventstore',
          args: { action: 'publishWithCorrectFlow', error: (e as any)?.message },
        });
        this.startRetryTimerIfNeeded();
      }

      if (published) {
        // Step 2: delete outbox rows and advance watermark. Only reached on successful publish.
        // If delete throws, rows stay in outbox and drain will redeliver (at-least-once) — acceptable.
        try {
          await this.adapter.deleteOutboxByIds(persisted.insertedOutboxIds);
          // BUG-6 fix: advance watermark so next hasPendingAfterId() skips
          // already-delivered ids, making fast-path reachable on subsequent saves.
          this.adapter.advanceWatermark(persisted.lastId);
        } catch (e) {
          this.logger.verbose('Fast-path outbox ACK delete failed, drain will redeliver', {
            module: 'eventstore',
            args: { action: 'publishWithCorrectFlow', error: (e as any)?.message },
          });
        }
      }
    }
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

  /**
   * Drains the outbox in multiple chunks. ACK policy: one ACK per chunk.
   * Chunk sizing and EMA hints are adapter-owned; service gives only the transport cap.
   */
  private async drainOutboxCompletely(): Promise<{ completed: boolean }> {
    if (!this.hasRemoteTransport()) return { completed: true };

    while (true) {
      try {
        const sent = await this.adapter.fetchDeliverAckChunk(this.transportMaxFrameBytes, async (events) => {
          const ack = await this.publisherProvider.publisher.publishWireStreamBatchWithAck(events);
          assertFullOutboxAck(ack, events.length);
          return ack;
        });
        if (sent === 0) return { completed: true };
      } catch (e) {
        this.logger.verbose('Outbox drain chunk failed', {
          module: 'eventstore',
          args: { action: 'drainOutboxCompletely', error: (e as any)?.message },
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
          const result = await this.runDrainOnce();
          if (!result.completed) return;

          reset();
          this.drainFailing = false;
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
  public async maybeCreateSnapshot(aggregate: T): Promise<void> {
    if (!aggregate.canMakeSnapshot()) return;

    const { minKeep, keepWindow } = aggregate.getSnapshotRetention();
    try {
      await this.adapter.createSnapshot(aggregate, { minKeep, keepWindow, allowPruning: false });
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
