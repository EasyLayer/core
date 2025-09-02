import type { Envelope } from '../../shared';
import { TRANSPORT_OVERHEAD_WIRE, Actions } from '../../shared';
import { BaseProducer, utf8Len } from '../base-producer';
import type { ProducerConfig } from '../base-producer';

const mockDestroy = jest.fn();
jest.mock('@easylayer/common/exponential-interval-async', () => {
  return {
    exponentialIntervalAsync: (fn: (reset: () => void) => Promise<void>, _opts: any) => {
      const controller = { destroy: mockDestroy };
      Promise.resolve().then(() => fn(() => {}));
      return controller;
    },
  };
});

class TestProducer extends BaseProducer {
  public connectedFlag = true;
  public lastSerialized: string | null = null;
  public lastByteLength = 0;
  public lastContext: unknown;
  public serializeInvocationCount = 0;
  public autoResolveAckPayload: unknown | null = null;

  constructor(overrides?: Partial<ProducerConfig>) {
    super({
      name: 'test',
      maxMessageBytes: 1024 * 1024,
      ackTimeoutMs: 200,
      heartbeatIntervalMs: 50,
      heartbeatTimeoutMs: 300,
      ...(overrides || {}),
    });
  }

  protected _isUnderlyingConnected(): boolean {
    return this.connectedFlag;
  }

  protected async _sendRaw(serialized: string, byteLength: number, context?: unknown): Promise<void> {
    this.lastSerialized = serialized;
    this.lastByteLength = byteLength;
    this.lastContext = context;
    if (this.autoResolveAckPayload !== null) {
      this.resolveAck(this.autoResolveAckPayload as any);
    }
  }

  public override serializeOnce(envelope: Envelope): { json: string; byteLength: number } {
    this.serializeInvocationCount++;
    const json = JSON.stringify(envelope);
    return { json, byteLength: utf8Len(json) };
  }
}

describe('BaseProducer utf8Len', () => {
  it('matches Buffer.byteLength for ascii, multibyte and surrogate pairs', () => {
    const samples = ['A', '€', '𐍈', 'hello мир € 𐍈'];
    for (const sample of samples) {
      expect(utf8Len(sample)).toBe(Buffer.byteLength(sample, 'utf8'));
    }
  });
});

describe('BaseProducer serializeOnce and _sendSerialized', () => {
  it('serializeOnce returns correct json and byte length', () => {
    const producer = new TestProducer();
    const envelope: Envelope = { action: 'x', payload: { a: 1 }, timestamp: 1 };
    const { json, byteLength } = producer.serializeOnce(envelope);
    expect(json).toBe(JSON.stringify(envelope));
    expect(byteLength).toBe(utf8Len(json));
  });

  it('_sendSerialized invokes serializeOnce once and calls _sendRaw with same values', async () => {
    const producer = new TestProducer();
    const envelope: Envelope = { action: 'y', payload: { b: 2 } };
    await (producer as any)._sendSerialized(envelope);
    expect(producer.serializeInvocationCount).toBe(1);
    expect(producer.lastSerialized).toBe(JSON.stringify(envelope));
    expect(producer.lastByteLength).toBe(utf8Len(JSON.stringify(envelope)));
  });
});

describe('BaseProducer sendMessage size checks', () => {
  it('throws when envelope exceeds maxMessageBytes including overhead', async () => {
    const producer = new TestProducer({ maxMessageBytes: 200 });
    const payloadSize = 300;
    const envelope: Envelope = { action: 'z', payload: { s: 'x'.repeat(payloadSize) } };
    await expect(producer.sendMessage(envelope)).rejects.toThrow('envelope too large');
    expect(producer.lastSerialized).toBeNull();
  });

  it('succeeds when envelope size plus overhead fits cap', async () => {
    const temp = new TestProducer();
    const envelope: Envelope = { action: 'ok', payload: { s: 'abc' } };
    const { json, byteLength } = temp.serializeOnce(envelope);
    const cap = byteLength + TRANSPORT_OVERHEAD_WIRE;
    const producer = new TestProducer({ maxMessageBytes: cap });
    await producer.sendMessage(envelope, { contextKey: 1 });
    expect(producer.lastSerialized).toBe(json);
    expect(producer.lastByteLength).toBe(byteLength);
    expect((producer as any).lastContext).toEqual({ contextKey: 1 });
  });
});

describe('BaseProducer waitForAck', () => {
  it('resolves with provided ack value', async () => {
    const producer = new TestProducer();
    producer.autoResolveAckPayload = { ok: true };
    const envelope: Envelope = { action: 'ack', payload: { v: 1 } };
    const result = await producer.waitForAck(async () => {
      await (producer as any)._sendSerialized(envelope);
    });
    expect(result).toEqual({ ok: true });
  });

  it('rejects on ACK timeout and allows subsequent call', async () => {
    jest.useFakeTimers();
    const producer = new TestProducer({ ackTimeoutMs: 50 });
    const envelope: Envelope = { action: 'ack-timeout' };
    const pending = producer.waitForAck(async () => {
      await (producer as any)._sendSerialized(envelope);
    });
    jest.advanceTimersByTime(60);
    await expect(pending).rejects.toThrow('ACK timeout');
    producer.autoResolveAckPayload = { ok: 2 };
    const next = producer.waitForAck(async () => {
      await (producer as any)._sendSerialized({ action: 'ack-2' });
    });
    await expect(next).resolves.toEqual({ ok: 2 });
    jest.useRealTimers();
  });

  it('throws if ack already pending', async () => {
    const producer = new TestProducer({ ackTimeoutMs: 1000 });
    const envelope: Envelope = { action: 'dup' };
    const first = producer.waitForAck(async () => {
      await (producer as any)._sendSerialized(envelope);
    });
    await expect(
      producer.waitForAck(async () => {
        await (producer as any)._sendSerialized({ action: 'dup2' });
      })
    ).rejects.toThrow('ack already pending');
    (producer as any).resolveAck({ ok: true });
    await first;
  });
});

describe('BaseProducer connection and waitForOnline', () => {
  it('isConnected returns false when underlying disconnected', () => {
    const producer = new TestProducer();
    producer.connectedFlag = false;
    expect(producer.isConnected()).toBe(false);
  });

  it('isConnected returns true after pong within timeout and false after timeout passes', () => {
    jest.useFakeTimers();
    const producer = new TestProducer({ heartbeatTimeoutMs: 100 });
    producer.connectedFlag = true;
    expect(producer.isConnected()).toBe(true);
    producer.onPong();
    expect(producer.isConnected()).toBe(true);
    jest.advanceTimersByTime(150);
    expect(producer.isConnected()).toBe(false);
    jest.useRealTimers();
  });

  it('waitForOnline resolves when connection appears before timeout', async () => {
    jest.useFakeTimers();
    const producer = new TestProducer();
    producer.connectedFlag = false;
    const promise = producer.waitForOnline(100);
    setTimeout(() => { producer.connectedFlag = true; }, 30);
    jest.advanceTimersByTime(30);
    await Promise.resolve();
    jest.advanceTimersByTime(30);
    await expect(promise).resolves.toBeUndefined();
    jest.useRealTimers();
  });

  it('waitForOnline rejects on timeout', async () => {
    jest.useFakeTimers();
    const producer = new TestProducer({ heartbeatTimeoutMs: 100 });
    producer.connectedFlag = false;
    const promise = producer.waitForOnline(50);
    jest.advanceTimersByTime(60);
    await expect(promise).rejects.toThrow('not online after 50ms');
    jest.useRealTimers();
  });
});

describe('BaseProducer heartbeat', () => {
  it('startHeartbeat sends ping when connected', async () => {
    const producer = new TestProducer();
    producer.connectedFlag = true;
    producer.startHeartbeat();
    await new Promise((r) => setTimeout(r, 0));
    expect(producer.lastSerialized).not.toBeNull();
    const parsed = JSON.parse(producer.lastSerialized!);
    expect(parsed.action).toBe(Actions.Ping);
    producer.stopHeartbeat();
  });

  it('startHeartbeat does not send ping when disconnected', async () => {
    const producer = new TestProducer();
    producer.connectedFlag = false;
    producer.startHeartbeat();
    await new Promise((r) => setTimeout(r, 0));
    expect(producer.lastSerialized).toBeNull();
    producer.stopHeartbeat();
  });
});
