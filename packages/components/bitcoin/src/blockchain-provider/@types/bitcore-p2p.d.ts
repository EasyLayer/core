declare module 'bitcore-p2p' {
  export interface NetworkConfig {
    name: string;
    alias?: string;
    pubkeyhash: number;
    privatekey: number;
    scripthash: number;
    xpubkey: number;
    xprivkey: number;
    networkMagic: number;
    port: number;
    dnsSeeds?: string[];
  }

  export interface PeerOptions {
    host: string;
    port: number;
  }

  export interface PoolOptions {
    network: NetworkConfig;
    maxSize?: number;
    dnsSeed?: boolean;
    listenAddr?: boolean;
  }

  export interface InventoryItem {
    type: number;
    hash: Buffer;
  }

  export interface BlockMessage {
    block: {
      hash: Buffer;
      toBuffer(): Buffer;
    };
  }

  export interface TransactionMessage {
    transaction: {
      hash: Buffer;
      toBuffer(): Buffer;
    };
  }

  export interface HeaderMessage {
    headers: Array<{
      hash: Buffer;
      [key: string]: any;
    }>;
  }

  export interface InventoryMessage {
    inventory: InventoryItem[];
  }

  export interface PingMessage {
    nonce: Buffer;
  }

  export class Peer {
    host: string;
    port: number;
    services?: bigint;
    
    constructor(options: PeerOptions);
    sendMessage(message: any): void;
    on(event: string, listener: (...args: any[]) => void): this;
    once(event: string, listener: (...args: any[]) => void): this;
    removeListener(event: string, listener: (...args: any[]) => void): this;
  }

  export class Pool {
    _connectedPeers?: Map<string, Peer>;
    
    constructor(options: PoolOptions);
    connect(): void;
    disconnect(): void;
    addPeer(peer: Peer): void;
    
    // Events
    on(event: 'peerready', listener: (peer: Peer) => void): this;
    on(event: 'peerdisconnect', listener: (peer: Peer, addr: string) => void): this;
    on(event: 'peerinv', listener: (peer: Peer, message: InventoryMessage) => void): this;
    on(event: 'peerblock', listener: (peer: Peer, message: BlockMessage) => void): this;
    on(event: 'peertx', listener: (peer: Peer, message: TransactionMessage) => void): this;
    on(event: 'peerheaders', listener: (peer: Peer, message: HeaderMessage) => void): this;
    on(event: 'peerping', listener: (peer: Peer, message: PingMessage) => void): this;
    on(event: 'peererror', listener: (peer: Peer, error: any) => void): this;
    on(event: string, listener: (...args: any[]) => void): this;
    
    once(event: 'peerready', listener: (peer: Peer) => void): this;
    once(event: string, listener: (...args: any[]) => void): this;
    
    removeListener(event: string, listener: (...args: any[]) => void): this;
  }

  export namespace Messages {
    export class GetHeaders {
      constructor(options: {
        starts: Buffer[];
        stop: Buffer;
      });
    }

    export class GetData {
      constructor(items: Array<{
        type: number;
        hash: Buffer;
      }>);
    }

    export class MemPool {
      constructor();
    }

    export class Pong {
      constructor(nonce: Buffer);
    }
  }
}