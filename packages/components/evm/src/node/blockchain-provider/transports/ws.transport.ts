import { BaseTransport } from '../../../core/blockchain-provider/transports/base.transport';
import { RpcError } from '../../../core/blockchain-provider/transports/errors';
import type { JsonRpcRequest } from '../../../core/blockchain-provider/transports/interfaces';

export interface WebSocketRpcTransportOptions {
  uniqName: string;
  wsUrl: string;
  responseTimeout?: number;
}

export interface JsonRpcSubscription {
  unsubscribe(): void;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason?: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class WebSocketRpcTransport extends BaseTransport {
  public readonly type = 'ws-rpc' as const;

  private readonly wsUrl: string;
  private readonly responseTimeout: number;
  private socket: WebSocket | null = null;
  private requestId = 1;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly subscriptionCallbacks = new Map<string, (payload: any) => void>();
  private connectPromise: Promise<void> | null = null;

  constructor(options: WebSocketRpcTransportOptions) {
    super();
    this.wsUrl = options.wsUrl;
    this.responseTimeout = options.responseTimeout ?? 5000;
  }

  async connect(): Promise<void> {
    if (this.isSocketOpen()) {
      return;
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const WebSocketCtor = (globalThis as any).WebSocket as typeof WebSocket | undefined;
      if (typeof WebSocketCtor !== 'function') {
        this.connectPromise = null;
        reject(new Error('Global WebSocket is not available'));
        return;
      }

      const socket = new WebSocketCtor(this.wsUrl);
      this.socket = socket;

      socket.onopen = () => {
        this.connectPromise = null;
        resolve();
      };

      socket.onmessage = (event: MessageEvent) => {
        this.handleMessage(event.data);
      };

      socket.onerror = (event: Event) => {
        const error = new RpcError(`EVM WebSocket connection error for ${this.wsUrl}`, event);
        this.rejectAll(error);
        this.socket = null;
        this.connectPromise = null;
        reject(error);
      };

      socket.onclose = () => {
        const error = new RpcError(`EVM WebSocket connection closed for ${this.wsUrl}`);
        this.rejectAll(error);
        this.socket = null;
        this.connectPromise = null;
      };
    });

    return this.connectPromise;
  }

  async request<T = any>(method: string, params: any[] = []): Promise<T> {
    const [result] = await this.batch<T>([{ method, params }]);
    if (result === null || result === undefined) {
      throw new RpcError(`EVM WebSocket ${method} returned empty result`);
    }
    return result;
  }

  async batch<T = any>(requests: JsonRpcRequest[]): Promise<Array<T | null>> {
    if (requests.length === 0) return [];

    await this.connect();
    const socket = this.requireSocket();

    const promises = requests.map((request) => {
      const id = this.requestId++;
      const payload = {
        jsonrpc: '2.0',
        id,
        method: request.method,
        params: request.params,
      };

      const promise = new Promise<T | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingRequests.delete(id);
          reject(new RpcError(`EVM WebSocket ${request.method} timed out after ${this.responseTimeout}ms`));
        }, this.responseTimeout);

        this.pendingRequests.set(id, { resolve, reject, timer });
      });

      socket.send(JSON.stringify(payload));
      return promise;
    });

    return Promise.all(promises);
  }

  async close(): Promise<void> {
    this.rejectAll(new RpcError('EVM WebSocket transport closed'));
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  async subscribe(method: string, params: any[], onMessage: (payload: any) => void): Promise<JsonRpcSubscription> {
    const subscriptionId = await this.request<string>('eth_subscribe', [method, ...params]);
    this.subscriptionCallbacks.set(subscriptionId, onMessage);

    return {
      unsubscribe: () => {
        this.subscriptionCallbacks.delete(subscriptionId);
        void this.request('eth_unsubscribe', [subscriptionId]).catch(() => undefined);
      },
    };
  }

  private handleMessage(raw: any): void {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;

    if (parsed?.method === 'eth_subscription') {
      const subscriptionId = parsed?.params?.subscription;
      const callback = typeof subscriptionId === 'string' ? this.subscriptionCallbacks.get(subscriptionId) : undefined;
      if (callback) {
        callback(parsed.params.result);
      }
      return;
    }

    const id = parsed?.id;
    if (typeof id !== 'number') {
      return;
    }

    const pending = this.pendingRequests.get(id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pendingRequests.delete(id);

    if (parsed?.error) {
      pending.reject(new RpcError(`JSON-RPC Error ${parsed.error.code}: ${parsed.error.message}`, parsed.error));
      return;
    }

    pending.resolve(parsed?.result ?? null);
  }

  private requireSocket(): WebSocket {
    if (!this.socket || !this.isSocketOpen()) {
      throw new RpcError(`EVM WebSocket is not connected: ${this.wsUrl}`);
    }
    return this.socket;
  }

  private isSocketOpen(): boolean {
    return !!this.socket && this.socket.readyState === WebSocket.OPEN;
  }

  private rejectAll(error: RpcError): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }
}
