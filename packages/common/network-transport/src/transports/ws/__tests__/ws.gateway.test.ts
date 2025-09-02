import type { Envelope, QueryRequestPayload, QueryResponsePayload, OutboxStreamAckPayload, PongPayload } from '../../../shared';
import { Actions } from '../../../shared';
import { WsGateway } from '../ws.gateway';
import type { WsProducer } from '../ws.producer';

function makeClient(id = 'sock-1') {
  const sent: any[] = [];
  const client = {
    id,
    emit: jest.fn((event: string, payload: any) => sent.push({ event, payload })),
  } as any;
  return { client, sent };
}

describe('WsGateway', () => {
  it('replies pong on ping', async () => {
    const { client, sent } = makeClient();
    const producer = {} as unknown as WsProducer;
    const gateway = new WsGateway({} as any, producer, undefined);
    const ping: Envelope = { action: Actions.Ping, timestamp: Date.now() };
    await gateway.handleMessage(JSON.stringify(ping), client);
    expect(sent.length).toBe(1);
    expect(sent[0].event).toBe('message');
    const msg = JSON.parse(sent[0].payload);
    expect(msg.action).toBe(Actions.Pong);
    expect(typeof msg.payload.ts).toBe('number');
    expect(typeof msg.timestamp).toBe('number');
  });

  it('handles pong with token: verifies proof, sets streaming client and marks pong', async () => {
    const { client } = makeClient('c-1');
    const producer = {
      verifyProof: jest.fn(() => true),
      setStreamingClient: jest.fn(),
      onClientPong: jest.fn(),
    } as unknown as WsProducer;
    const gateway = new WsGateway({} as any, producer, 'token-x');
    const payload: PongPayload = { ts: Date.now(), nonce: 'n1', proof: 'p1', sid: 'c-1' } as any;
    const msg: Envelope<PongPayload> = { action: Actions.Pong, payload, timestamp: Date.now() };
    await gateway.handleMessage(JSON.stringify(msg), client as any);
    expect((producer as any).verifyProof).toHaveBeenCalledWith('c-1', 'n1', payload.ts, 'p1');
    expect((producer as any).setStreamingClient).toHaveBeenCalledWith('c-1');
    expect((producer as any).onClientPong).toHaveBeenCalledTimes(1);
  });

  it('ignores pong with invalid proof when token present', async () => {
    const { client } = makeClient('c-2');
    const producer = {
      verifyProof: jest.fn(() => false),
      setStreamingClient: jest.fn(),
      onClientPong: jest.fn(),
    } as unknown as WsProducer;
    const gateway = new WsGateway({} as any, producer, 'token-x');
    const payload: PongPayload = { ts: Date.now(), nonce: 'n1', proof: 'bad', sid: 'c-2' } as any;
    const msg: Envelope<PongPayload> = { action: Actions.Pong, payload, timestamp: Date.now() };
    await gateway.handleMessage(msg, client as any);
    expect((producer as any).verifyProof).toHaveBeenCalled();
    expect((producer as any).setStreamingClient).not.toHaveBeenCalled();
    expect((producer as any).onClientPong).not.toHaveBeenCalled();
  });

  it('marks pong without token regardless of proof presence', async () => {
    const { client } = makeClient('c-3');
    const producer = {
      onClientPong: jest.fn(),
    } as unknown as WsProducer;
    const gateway = new WsGateway({} as any, producer, undefined);
    const payload: PongPayload = { ts: Date.now() } as any;
    await gateway.handleMessage({ action: Actions.Pong, payload }, client as any);
    expect((producer as any).onClientPong).toHaveBeenCalledTimes(1);
  });

  it('handles QueryRequest and emits QueryResponse with same ids on success', async () => {
    const { client, sent } = makeClient('c-4');
    const producer = {} as unknown as WsProducer;
    const gateway = new WsGateway({} as any, producer, undefined);
    jest.spyOn(gateway as any, 'executeQuery').mockResolvedValue({ ok: true });

    const incoming: Envelope<QueryRequestPayload> = {
      action: Actions.QueryRequest,
      payload: { name: 'Health', dto: { a: 1 } },
      requestId: 'rid-1',
      correlationId: 'cid-1',
      timestamp: Date.now(),
    };
    await gateway['handleMessage'](incoming, client as any);

    expect(sent.length).toBe(1);
    const out = JSON.parse(sent[0].payload) as Envelope<QueryResponsePayload>;
    expect(out.action).toBe(Actions.QueryResponse);
    expect(out.requestId).toBe('rid-1');
    expect(out.correlationId).toBe('cid-1');
    expect(out.payload?.name).toBe('Health');
    expect(out.payload?.data).toEqual({ ok: true });
    expect(typeof out.timestamp).toBe('number');
  });

  it('handles QueryRequest error path and emits err field', async () => {
    const { client, sent } = makeClient('c-5');
    const producer = {} as unknown as WsProducer;
    const gateway = new WsGateway({} as any, producer, undefined);
    jest.spyOn(gateway as any, 'executeQuery').mockRejectedValue(new Error('boom'));

    const incoming: Envelope<QueryRequestPayload> = {
      action: Actions.QueryRequest,
      payload: { name: 'GetX', dto: { z: 1 } },
      requestId: 'r2',
      correlationId: 'c2',
      timestamp: Date.now(),
    };
    await gateway['handleMessage'](incoming, client as any);

    const out = JSON.parse(sent[0].payload) as Envelope<QueryResponsePayload>;
    expect(out.action).toBe(Actions.QueryResponse);
    expect(out.requestId).toBe('r2');
    expect(out.correlationId).toBe('c2');
    expect(out.payload?.name).toBe('GetX');
    expect(typeof out.payload?.err).toBe('string');
  });

  it('routes OutboxStreamAck to producer.resolveAck', async () => {
    const { client } = makeClient('c-6');
    const producer = { resolveAck: jest.fn() } as any;
    const gateway = new WsGateway({} as any, producer, undefined);
    const ackPayload: OutboxStreamAckPayload = { allOk: true, okIndices: [0] };
    await gateway.handleMessage({ action: Actions.OutboxStreamAck, payload: ackPayload }, client as any);
    expect((producer as any).resolveAck).toHaveBeenCalledWith(ackPayload);
  });
});
