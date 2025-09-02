import type { AppLogger } from '@easylayer/common/logger';
import type { BaseProducer } from './base-producer';
import type { Envelope, OutboxStreamBatchPayload, OutboxStreamAckPayload, WireEventRecord } from '../shared';
import { Actions } from '../shared';

export class OutboxStreamManager {
  private readonly log: AppLogger;
  private producer: BaseProducer | null = null;

  constructor(log: AppLogger) {
    this.log = log;
  }

  public setProducer(producer: BaseProducer | null): void {
    this.producer = producer ?? null;
  }

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
