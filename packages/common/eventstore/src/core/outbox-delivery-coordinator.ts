export interface OutboxDeliveryRunContext {
  flowId: number;
  source: string;
  queuedAt: number;
  startedAt: number;
  queueWaitMs: number;
}

export type OutboxDeliveryObserver = (event: {
  phase: 'queued' | 'started' | 'completed' | 'failed';
  flowId: number;
  source: string;
  queueWaitMs?: number;
  durationMs?: number;
  error?: unknown;
}) => void;

/**
 * Serializes remote outbox table draining inside one JS process.
 *
 * Remote delivery has one source of truth: persisted outbox rows. The
 * coordinator ensures that startup drains, save-triggered drains and retry
 * drains never select/send/delete/watermark concurrently.
 *
 * This is intentionally process-local and does not change the outbox DB schema.
 * It is not a delay buffer: the next drain starts immediately after the previous
 * drain finishes ACK/delete/watermark or fails and leaves rows for retry.
 */
export class OutboxDeliveryCoordinator {
  private nextFlowId = 1;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly observe?: OutboxDeliveryObserver) {}

  async run<T>(source: string, handler: (ctx: OutboxDeliveryRunContext) => Promise<T>): Promise<T> {
    const flowId = this.nextFlowId++;
    const queuedAt = Date.now();
    this.observe?.({ phase: 'queued', flowId, source });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const previous = this.tail;
    this.tail = previous.catch(() => undefined).then(() => gate);

    await previous.catch(() => undefined);

    const startedAt = Date.now();
    const ctx: OutboxDeliveryRunContext = {
      flowId,
      source,
      queuedAt,
      startedAt,
      queueWaitMs: startedAt - queuedAt,
    };

    this.observe?.({ phase: 'started', flowId, source, queueWaitMs: ctx.queueWaitMs });
    try {
      const result = await handler(ctx);
      this.observe?.({ phase: 'completed', flowId, source, durationMs: Date.now() - startedAt });
      return result;
    } catch (error) {
      this.observe?.({ phase: 'failed', flowId, source, durationMs: Date.now() - startedAt, error });
      throw error;
    } finally {
      release();
    }
  }
}
