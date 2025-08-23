import type { AppLogger } from '@easylayer/common/logger';
import type { Envelope, PongPayload } from '../shared';
import { Actions } from '../shared';

/**
 * BaseConsumer:
 * - Handles ping → pong automatically.
 * - Delegates business messages to subclasses.
 * Complexity: O(1) per message, trivial allocations.
 */
export abstract class BaseConsumer {
  protected readonly log: AppLogger;

  protected constructor(log: AppLogger) {
    this.log = log;
  }

  public async onMessage(msg: Envelope, ctx?: unknown): Promise<void> {
    switch (msg.action) {
      case Actions.Ping: {
        await this.sendPong(ctx);
        return;
      }
      default:
        await this.handleBusinessMessage(msg, ctx);
    }
  }

  protected async sendPong(ctx?: unknown) {
    const m: Envelope<PongPayload> = { action: Actions.Pong, payload: { ts: Date.now() }, timestamp: Date.now() };
    await this._send(m, ctx);
  }

  protected abstract handleBusinessMessage(msg: Envelope, ctx?: unknown): Promise<void>;
  protected abstract _send(msg: Envelope, ctx?: unknown): Promise<void>;
}
