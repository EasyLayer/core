import { Logger } from '@nestjs/common';
import type { BaseProducer } from './base-producer';
import type { Envelope, OutboxStreamBatchPayload, OutboxStreamAckPayload, WireEventRecord } from './messages';
import { Actions } from './messages';

export class OutboxStreamManager {
  private logger = new Logger(OutboxStreamManager.name);
  private producer: BaseProducer | null = null;

  /* eslint-disable no-empty */
  public setProducer(next: BaseProducer | null): void {
    const prev = this.producer;
    if (prev && prev !== next) {
      try {
        prev.destroy?.();
      } catch {}
    }
    this.producer = next ?? null;
  }
  /* eslint-enable no-empty */

  public getProducer(): BaseProducer | null {
    return this.producer;
  }

  public async streamWireWithAck(events: WireEventRecord[]): Promise<OutboxStreamAckPayload> {
    if (!this.producer) {
      return { allOk: true, okIndices: [] };
    }

    await this.producer.waitForOnline(5000);

    const envelope: Envelope<OutboxStreamBatchPayload> = {
      action: Actions.OutboxStreamBatch,
      payload: { events },
      timestamp: Date.now(),
    };

    const ack = await this.producer.waitForAck<OutboxStreamAckPayload>(async () => {
      await this.producer!.sendMessage(envelope);
    });

    return ack;
  }
}
