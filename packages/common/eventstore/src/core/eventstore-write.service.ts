import { Injectable, OnModuleDestroy, OnModuleInit, Logger } from '@nestjs/common';
import { ExponentialTimer, exponentialIntervalAsync } from '@easylayer/common/exponential-interval-async';
import type { AggregateRoot } from '@easylayer/common/cqrs';
import { PublisherProvider, WireEventRecord } from '@easylayer/common/cqrs-transport';
import type { BaseAdapter } from './base-adapter';
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
  logger = new Logger(EventStoreWriteService.name);

  private retryTimer: ExponentialTimer | null = null;

  // Default 10 MB — must match transport-sdk maxWireBytes and SDK client maxWireBytes.
  // Bitcoin block events can reach 2–4 MB serialized; 1 MB caused permanent outbox stall.
  private transportMaxFrameBytes = 10 * 1024 * 1024;

  private draining: Promise<void> | null = null;

  constructor(
    private readonly adapter: BaseAdapter<T>,
    private readonly publisherProvider: PublisherProvider,
    private readonly eventStoreReadService: EventStoreReadService,
    config: any
  ) {
    if (config?.transportMaxFrameBytes !== undefined) this.transportMaxFrameBytes = config.transportMaxFrameBytes;
  }

  async onModuleInit(): Promise<void> {
    this.logger.verbose('Startup outbox drain started', { module: 'eventstore' });
    await this.runDrainOnce();
  }

  onModuleDestroy(): void {
    this.retryTimer?.destroy();
    this.retryTimer = null;
  }

  private async runDrainOnce(): Promise<void> {
    if (this.draining) {
      await this.draining;
      return;
    }

    this.draining = (async () => {
      try {
        await this.drainOutboxCompletely();
      } finally {
        this.draining = null;
      }
    })();

    await this.draining;
  }

  /**
   * Persist → snapshot → publish (RAW fast-path if safe; otherwise strict outbox) → ACK.
   * DB writes and outbox are atomic per adapter implementation.
   */
  public async save(models: T | T[]): Promise<void> {
    const aggregates = Array.isArray(models) ? models : [models];

    // One DB transaction that writes aggregate tables + outbox.
    const persisted = await this.adapter.persistAggregatesAndOutbox(aggregates);

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

    // Publish using the correct flow based on backlog conditions.
    await this.publishWithCorrectFlow(persisted);
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

    const anyPending = await this.adapter.hasAnyPendingAfterWatermark();
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
        await this.publisherProvider.publisher.publishWireStreamBatchWithAck(persisted.rawEvents);
        published = true;
      } catch (e) {
        this.logger.verbose('Fast-path publish failed, outbox retained for drain retry', {
          module: 'eventstore',
          args: { action: 'publishWithCorrectFlow', error: (e as any)?.message },
        });
      }

      if (published) {
        // Step 2: delete outbox rows and advance watermark. Only reached on successful publish.
        // If delete throws, rows stay in outbox and drain will redeliver (at-least-once) — acceptable.
        try {
          await this.adapter.deleteOutboxByIds(persisted.insertedOutboxIds);
          // BUG-6 fix: advance watermark so next hasAnyPendingAfterWatermark() skips
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
  private async drainOutboxCompletely(): Promise<void> {
    while (true) {
      try {
        const sent = await this.adapter.fetchDeliverAckChunk(this.transportMaxFrameBytes, async (events) => {
          await this.publisherProvider.publisher.publishWireStreamBatchWithAck(events);
        });
        if (sent === 0) break;
      } catch (e) {
        this.logger.verbose('Outbox drain chunk failed', {
          module: 'eventstore',
          args: { action: 'drainOutboxCompletely', error: (e as any)?.message },
        });
        this.startRetryTimerIfNeeded();
        // BUG-3 fix: stop the loop after scheduling retry — avoids tight CPU spin on persistent errors.
        break;
      }
    }
  }

  private startRetryTimerIfNeeded(): void {
    if (this.retryTimer) return;
    this.logger.verbose('Outbox retry timer started', {
      module: 'eventstore',
      args: { action: 'startRetryTimerIfNeeded' },
    });
    this.retryTimer = exponentialIntervalAsync(
      async (reset) => {
        try {
          await this.runDrainOnce();
          reset();
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
      await this.adapter.createSnapshot(aggregate, { minKeep, keepWindow });
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
