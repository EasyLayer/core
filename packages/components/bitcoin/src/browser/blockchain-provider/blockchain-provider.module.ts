import { Module, DynamicModule, Logger } from '@nestjs/common';
import {
  BlockchainProviderService,
  NetworkConnectionManager,
  MempoolConnectionManager,
  NetworkProvider,
  MempoolProvider,
  KeyManagementService,
  ScriptUtilService,
  WalletService,
  TransactionService,
} from '../../core';
// import { KeyManagementService, ScriptUtilService, WalletService, TransactionService } from '../../blockchain-provider/utils';
import type { NetworkConfig, RateLimits } from '../../core';
import { RPCTransport as BrowserRPC } from './transports';

export interface ProviderConnectionConfig {
  /** For RPC: base URL (required), for P2P: not used */
  baseUrl?: string;
  /** For P2P: array of peers (required), for RPC: not used */
  peers?: Array<{ host: string; port: number }>;
  /** Optional custom name for the provider connection */
  uniqName?: string;

  // RPC specific options
  /** HTTP request timeout in milliseconds (default: 5000) */
  responseTimeout?: number;
  /** Connection timeout in milliseconds (default: 30000) */
  connectionTimeout?: number;

  defaultStrategy?: 'parallel' | 'round-robin' | 'fastest';
}

export interface ModuleProviderConfig {
  type: 'rpc';
  connections: ProviderConnectionConfig[];
}

/**
 * Main configuration for blockchain provider module
 */
export interface BlockchainProviderModuleOptions {
  /** Network providers configuration (for blocks, transactions, blockchain info) */
  networkProviders: ModuleProviderConfig;
  /** Mempool providers configuration (for mempool operations) */
  mempoolProviders: ModuleProviderConfig;
  /** Network configuration (Bitcoin mainnet, testnet, etc.) */
  network: NetworkConfig;
  /** Rate limiting configuration for transport layer */
  rateLimits: RateLimits;
  /** Make module global (available to all modules without imports) */
  isGlobal?: boolean;
}

@Module({})
export class BlockchainProviderModule {
  static async forRootAsync(opts: BlockchainProviderModuleOptions): Promise<DynamicModule> {
    const { networkProviders, mempoolProviders, network, rateLimits, isGlobal } = opts;

    const buildRPCTransports = (cfg: ModuleProviderConfig) =>
      cfg.connections.map((c, i) => {
        if (cfg.type !== 'rpc') throw new Error('P2P is not available in browser');
        if (!c.baseUrl) throw new Error(`RPC connection ${i}: baseUrl required`);
        return new BrowserRPC({
          uniqName: c.uniqName ?? `rpc_${i + 1}`,
          baseUrl: c.baseUrl,
          responseTimeout: c.responseTimeout,
          network,
          rateLimits,
        });
      });

    const buildNetworkProviders = () => buildRPCTransports(networkProviders).map((t) => new NetworkProvider(t));

    const buildMempoolProviders = () => buildRPCTransports(mempoolProviders).map((t) => new MempoolProvider(t));

    const providers = [
      {
        provide: NetworkConnectionManager,
        useFactory: async () => {
          const provs = buildNetworkProviders();
          const logger = new Logger(NetworkConnectionManager.name);
          const cm = new NetworkConnectionManager({ providers: provs, logger });
          if (provs.length) await cm.initialize();
          return cm;
        },
        inject: [],
      },
      {
        provide: MempoolConnectionManager,
        useFactory: async () => {
          const provs = buildMempoolProviders();
          const logger = new Logger(MempoolConnectionManager.name);
          const cm = new MempoolConnectionManager({ providers: provs, logger });
          if (provs.length) await cm.initialize();
          return cm;
        },
        inject: [],
      },
      {
        provide: BlockchainProviderService,
        useFactory: (ncm: NetworkConnectionManager, mcm: MempoolConnectionManager) =>
          new BlockchainProviderService(ncm, mcm, network),
        inject: [NetworkConnectionManager, MempoolConnectionManager],
      },
      KeyManagementService,
      ScriptUtilService,
      WalletService,
      TransactionService,
    ];

    return {
      module: BlockchainProviderModule,
      global: isGlobal ?? false,
      providers,
      exports: [BlockchainProviderService, KeyManagementService, ScriptUtilService, WalletService, TransactionService],
    };
  }
}
