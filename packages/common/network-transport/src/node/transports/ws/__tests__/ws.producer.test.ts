import { Actions } from '../../../../core';
import type { Envelope } from '../../../../core';
import { WsProducer } from '../ws.producer';
import { createHmac } from 'node:crypto';

function makeIOServer() {
  const socketsMap = new Map<string, any>();
  const server = {
    sockets: { sockets: socketsMap },
    on: jest.fn(),
    close: jest.fn(),
  } as any;
  return { server, socketsMap };
}

function makeSocket(id = 's1') {
  const sent: any[] = [];
  const socket = { id, emit: jest.fn((event: string, payload: any) => sent.push({ event, payload })) } as any;
  return { socket, sent };
}

describe('WsProducer', () => {
  it('_isUnderlyingConnected depends on server and streaming client presence', () => {
    const p = new WsProducer({ name: 'ws', maxMessageBytes: 1024 * 1024, ackTimeoutMs: 500 });
    expect((p as any)._isUnderlyingConnected()).toBe(false);
    const { server, socketsMap } = makeIOServer();
    p.setServer(server as any);
    p.setStreamingClient('s1');
    expect((p as any)._isUnderlyingConnected()).toBe(false);
    const { socket } = makeSocket('s1');
    socketsMap.set('s1', socket);
    expect((p as any)._isUnderlyingConnected()).toBe(true);
  });

  it('_sendRaw emits serialized message to streaming client', async () => {
    const p = new WsProducer({ name: 'ws', maxMessageBytes: 1024 * 1024, ackTimeoutMs: 500 });
    const { server, socketsMap } = makeIOServer();
    const { socket, sent } = makeSocket('s2');
    socketsMap.set('s2', socket);
    p.setServer(server as any);
    p.setStreamingClient('s2');
    const envelope: Envelope = { action: 'x', payload: { a: 1 } };
    await (p as any)._sendSerialized(envelope);
    expect(sent.length).toBe(1);
    expect(sent[0].event).toBe('message');
    const parsed = JSON.parse(sent[0].payload);
    expect(parsed.action).toBe('x');
    expect(parsed.payload).toEqual({ a: 1 });
  });

  it('_sendRaw throws when no streaming client', async () => {
    const p = new WsProducer({ name: 'ws', maxMessageBytes: 1024 * 1024, ackTimeoutMs: 500 });
    const { server } = makeIOServer();
    p.setServer(server as any);
    p.setStreamingClient('missing');
    await expect((p as any)._sendRaw(JSON.stringify({}))).rejects.toThrow('[ws] no streaming client connected');
  });

  it('buildPingEnvelope without connected client falls back to base ping', () => {
    const p = new WsProducer({ name: 'ws', maxMessageBytes: 1024 * 1024, ackTimeoutMs: 500 });
    const env = (p as any).buildPingEnvelope();
    expect(env.action).toBe(Actions.Ping);
    expect(typeof env.payload.ts).toBe('number');
    expect(env.payload.nonce).toBeUndefined();
    expect(env.payload.sid).toBeUndefined();
  });

  it('buildPingEnvelope with client adds sid and nonce and verifyProof validates once', () => {
    const p = new WsProducer({
      name: 'ws',
      maxMessageBytes: 1024 * 1024,
      ackTimeoutMs: 500,
      heartbeatTimeoutMs: 1000,
      token: 'tok',
    });
    const { server, socketsMap } = makeIOServer();
    const { socket } = makeSocket('s3');
    socketsMap.set('s3', socket);
    p.setServer(server as any);
    p.setStreamingClient('s3');

    const env = (p as any).buildPingEnvelope();
    expect(env.action).toBe(Actions.Ping);
    expect(env.payload.sid).toBe('s3');
    expect(typeof env.payload.nonce).toBe('string');
    const nonce = env.payload.nonce as string;
    const ts = env.payload.ts as number;
    const proof = createHmac('sha256', 'tok').update(`${nonce}|${ts}|s3`).digest('hex');
    expect(p.verifyProof('s3', nonce, ts, proof)).toBe(true);
    expect(p.verifyProof('s3', nonce, ts, proof)).toBe(false);
  });

  it('onClientPong marks connection alive via onPong()', () => {
    jest.useFakeTimers();
    const p = new WsProducer({ name: 'ws', maxMessageBytes: 1024 * 1024, ackTimeoutMs: 200, heartbeatTimeoutMs: 100 });
    const { server, socketsMap } = makeIOServer();
    const { socket } = makeSocket('s4');
    socketsMap.set('s4', socket);
    p.setServer(server as any);
    p.setStreamingClient('s4');
    p.onClientPong();
    expect(p.isConnected()).toBe(true);
    jest.advanceTimersByTime(150);
    expect(p.isConnected()).toBe(false);
    jest.useRealTimers();
  });
});
