/// <reference types="node" />

declare module 'bitcoin-core' {
  export interface BitcoinCoreConnectionOptions {
    agentOptions?: any;
    allowDefaultWallet?: any;
    headers?: any;
    ssl?: any;
    timeout?: any;
    version?: any;
    wallet?: any;
    network?: string;
    username?: string;
    password?: string;
    host?: string;
    port?: number;
  }

  export class Client {
    constructor(options: BitcoinCoreConnectionOptions);
    getBlockCount(): Promise<number>;
    getRawTransaction(txId: string, decode: boolean): Promise<any>;
    // ...
  }

  // Export additional types if needed
}
