import type { Envelope } from '../messages';
import { Actions } from '../messages';
import { BaseConsumer } from '../base-consumer';

jest.mock('@easylayer/common/cqrs', () => ({ setQueryMetadata: jest.fn() }));

class TestConsumer extends BaseConsumer {
  public sent: Array<Envelope & { _context?: unknown }> = [];
  public lastBusiness?: { message: Envelope; context?: unknown };
  public lastPong?: { message: Envelope; context?: unknown };
  public lastQuery?: { message: Envelope; context?: unknown };

  constructor() { super(); }

  public makeQueryResponse(payload: any, requestId?: string, correlationId?: string) {
    return this.createQueryResponse(payload, requestId, correlationId);
  }

  public execQuery(queryBus: any, req: any, dto: any) {
    // @ts-ignore
    return this.executeQuery(queryBus, req, dto);
  }

  protected async handleBusinessMessage(message: Envelope, context?: unknown): Promise<void> {
    this.lastBusiness = { message, context };
  }

  protected async handlePong(message: Envelope, context?: unknown): Promise<void> {
    this.lastPong = { message, context };
  }

  protected async handleQueryMessage(message: Envelope, context?: unknown): Promise<void> {
    this.lastQuery = { message, context };
  }

  protected async _send(message: Envelope, context?: unknown): Promise<void> {
    this.sent.push(Object.assign({}, message, { _context: context }));
  }
}

describe('BaseConsumer', () => {
  it('onMessage ping -> sends pong once with numeric ts and timestamp, preserves context', async () => {
    const c = new TestConsumer();
    const ctx = { x: 1 };
    await c.onMessage({ action: Actions.Ping }, ctx);
    expect(c.sent.length).toBe(1);
    expect(c.sent[0]!.action).toBe(Actions.Pong);
    expect(typeof (c.sent[0]!.payload as any).ts).toBe('number');
    expect(typeof c.sent[0]!.timestamp).toBe('number');
    expect((c.sent[0] as any)._context).toBe(ctx);
  });

  it('onMessage pong -> delegates to handlePong with same message and context', async () => {
    const c = new TestConsumer();
    const msg: Envelope = { action: Actions.Pong, payload: { ts: 123 }, timestamp: 10 };
    const ctx = { who: 'client' };
    await c.onMessage(msg, ctx);
    expect(c.lastPong?.message).toEqual(msg);
    expect(c.lastPong?.context).toBe(ctx);
  });

  it('onMessage query.request -> delegates to handleQueryMessage', async () => {
    const c = new TestConsumer();
    const msg: Envelope = { action: Actions.QueryRequest, payload: { name: 'Health', dto: { a: 1 } } };
    await c.onMessage(msg);
    expect(c.lastQuery?.message).toEqual(msg);
  });

  it('onMessage other action -> delegates to handleBusinessMessage', async () => {
    const c = new TestConsumer();
    const msg: Envelope = { action: 'custom.action', payload: { z: true } };
    const ctx = { ctx: 1 };
    await c.onMessage(msg, ctx);
    expect(c.lastBusiness?.message).toEqual(msg);
    expect(c.lastBusiness?.context).toBe(ctx);
  });

  it('createQueryResponse builds proper envelope with ids and timestamp', () => {
    const c = new TestConsumer();
    const resp = c.makeQueryResponse({ name: 'Q', data: { ok: 1 } }, 'rid-1', 'cid-1');
    expect(resp.action).toBe(Actions.QueryResponse);
    expect(resp.payload).toEqual({ name: 'Q', data: { ok: 1 } });
    expect(resp.requestId).toBe('rid-1');
    expect(resp.correlationId).toBe('cid-1');
    expect(typeof resp.timestamp).toBe('number');
  });

  it('executeQuery constructs dynamic query class with provided name and dto, calls bus and returns result', async () => {
    const c = new TestConsumer();
    const dto = { id: 42, q: 'x' };
    const bus = { execute: jest.fn().mockResolvedValue({ ok: true }) };
    const result = await c.execQuery(bus, 'GetUser', dto);
    expect(result).toEqual({ ok: true });
    expect(bus.execute).toHaveBeenCalledTimes(1);
    const instance = bus.execute.mock.calls[0][0];
    expect(Object.getPrototypeOf(instance).constructor.name).toBe('GetUser');
    expect(instance.payload).toEqual(dto);
  });

  it('executeQuery throws on invalid name', async () => {
    const c = new TestConsumer();
    const bus = { execute: jest.fn() };
    await expect(c.execQuery(bus, '', {})).rejects.toThrow('Query name must be a non-empty string');
    await expect(c.execQuery(bus, 123, {})).rejects.toThrow('Query name must be a non-empty string');
  });
});
