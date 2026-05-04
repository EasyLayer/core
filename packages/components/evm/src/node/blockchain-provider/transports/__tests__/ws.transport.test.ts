import { WebSocketRpcTransport } from '../ws.transport';

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  public readyState = MockWebSocket.OPEN;
  public onopen: (() => void) | null = null;
  public onmessage: ((event: { data: string }) => void) | null = null;
  public onerror: ((event: Event) => void) | null = null;
  public onclose: (() => void) | null = null;
  public readonly sent: string[] = [];

  constructor(public readonly url: string) {
    MockWebSocket.instances.push(this);
    setTimeout(() => this.onopen?.(), 0);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  emitMessage(payload: any) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

describe('WebSocketRpcTransport', () => {
  beforeEach(() => {
    MockWebSocket.instances.length = 0;
    (globalThis as any).WebSocket = MockWebSocket as any;
  });

  it('resolves request by matching response id', async () => {
    const transport = new WebSocketRpcTransport({
      uniqName: 'ws-test',
      wsUrl: 'wss://example.com',
      responseTimeout: 100,
    });

    const promise = transport.request<string>('eth_blockNumber', []);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const socket = MockWebSocket.instances[0]!;
    socket.emitMessage({ jsonrpc: '2.0', id: 1, result: '0x10' });

    await expect(promise).resolves.toBe('0x10');
    await transport.close();
  });

  it('delivers subscription payloads to registered callback', async () => {
    const transport = new WebSocketRpcTransport({
      uniqName: 'ws-sub-test',
      wsUrl: 'wss://example.com',
      responseTimeout: 100,
    });

    const callback = jest.fn();
    const subscriptionPromise = transport.subscribe('newHeads', [], callback);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const socket = MockWebSocket.instances[0]!;
    socket.emitMessage({ jsonrpc: '2.0', id: 1, result: 'sub-1' });
    const subscription = await subscriptionPromise;

    socket.emitMessage({
      jsonrpc: '2.0',
      method: 'eth_subscription',
      params: {
        subscription: 'sub-1',
        result: { number: '0x123' },
      },
    });

    expect(callback).toHaveBeenCalledWith({ number: '0x123' });
    subscription.unsubscribe();
    await transport.close();
  });
});
