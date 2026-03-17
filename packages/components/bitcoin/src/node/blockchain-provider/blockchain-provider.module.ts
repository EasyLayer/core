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
import {
  RPCTransport as NodeRPC,
  P2PTransport as NodeP2P,
  MempoolSpaceTransport as NodeMempoolSpace,
} from './transports';

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
  /** ZMQ endpoint for real-time block notifications (format: tcp://host:port) */
  zmqEndpoint?: string;

  // P2P specific options
  /** Maximum number of peers to connect to (default: number of peers in array) */
  maxPeers?: number;
  /** Connection timeout in milliseconds (default: 30000) */
  connectionTimeout?: number;

  // P2P Header Sync Configuration (NEW)
  /**
   * Maximum height to sync headers (for testing or limited sync)
   * If undefined, syncs all headers from genesis to current tip
   * Memory usage: ~72 bytes per block
   * For maxHeight=100000: ~7.2MB, for full Bitcoin mainnet (~870k blocks): ~60MB
   */
  maxHeight?: number;

  /**
   * Enable automatic header synchronization on connect (default: true)
   * When true, starts downloading all block headers to build height->hash mapping
   * When false, P2P transport will only work with block hash-based operations
   *
   * Note: Header sync is essential for height-based block operations in P2P mode
   * Disabling this will make getBasicBlockByHeight() and similar methods fail
   */
  headerSyncEnabled?: boolean;

  /**
   * Batch size for header requests during sync (default: 2000, recommended: 1000-2000)
   * Larger batches = faster sync but more memory usage per request
   * Smaller batches = slower sync but more granular progress tracking
   *
   * Time complexity: O(n/batchSize) requests where n = number of blocks to sync
   */
  headerSyncBatchSize?: number;

  defaultStrategy?: 'parallel' | 'round-robin' | 'fastest';
}

export interface ModuleProviderConfig {
  type: 'rpc' | 'p2p' | 'mempool.space';
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

/**
 * Blockchain Provider Module
 *
 * Provides unified interface for Bitcoin-compatible blockchain operations supporting:
 * - Multiple transport types: RPC (JSON-RPC over HTTP) and P2P (direct Bitcoin protocol)
 * - Multiple connection strategies: Single active (Network) vs Multi-provider (Mempool)
 * - Bitcoin-compatible chains: BTC, BCH, DOGE, LTC via network config
 * - Automatic failover and error recovery
 * - Real-time subscriptions (ZMQ for RPC, direct P2P messages)
 * - Batch optimization for performance
 *
 * Memory considerations:
 * - P2P transport with header sync: ~60MB for full Bitcoin mainnet
 * - RPC transport: Minimal memory usage
 * - No block/transaction caching - immediate processing and forwarding
 *
 * Performance characteristics:
 * - Batch operations: O(1) network round-trip for multiple requests
 * - P2P header sync: O(n) where n = number of blocks (runs in background)
 * - Provider switching: O(1) with automatic failover
 */
@Module({})
export class BlockchainProviderModule {
  private static readonly logger = new Logger(BlockchainProviderModule.name);
  private static readonly moduleName = 'blockchain-provider';

  static async forRootAsync(opts: BlockchainProviderModuleOptions): Promise<DynamicModule> {
    const { networkProviders, mempoolProviders, network, rateLimits, isGlobal } = opts;
    // Capture for use inside closures where `this` is unavailable
    const logger = BlockchainProviderModule.logger;
    const moduleName = BlockchainProviderModule.moduleName;

    logger.verbose('Starting blockchain provider module registration', {
      module: moduleName,
    });

    const buildTransports = (cfg: ModuleProviderConfig) =>
      (cfg.connections ?? []).map((c, i) => {
        if (cfg.type === 'rpc') {
          if (!c.baseUrl) {
            logger.error(`RPC connection [${i}]: baseUrl is required but not provided`, {
              module: moduleName,
            });
            throw new Error(`RPC connection ${i}: baseUrl required`);
          }
          return new NodeRPC({
            uniqName: c.uniqName ?? `rpc_${i + 1}`,
            baseUrl: c.baseUrl,
            responseTimeout: c.responseTimeout,
            zmqEndpoint: c.zmqEndpoint,
            network,
            rateLimits,
          });
        }
        if (cfg.type === 'mempool.space') {
          if (!c.baseUrl) {
            logger.error(`Mempool.Space connection [${i}]: baseUrl is required but not provided`, {
              module: moduleName,
            });
            throw new Error(`Mempool.Space connection ${i}: baseUrl required`);
          }
          return new NodeMempoolSpace({
            uniqName: c.uniqName ?? `mempool_space_${i + 1}`,
            baseUrl: c.baseUrl,
            responseTimeout: c.responseTimeout,
            zmqEndpoint: c.zmqEndpoint,
            network,
            rateLimits,
          });
        }
        if (!c.peers?.length) {
          logger.error(`P2P connection [${i}]: peers are required but not provided`, {
            module: moduleName,
          });
          throw new Error(`P2P connection ${i}: peers required`);
        }
        return new NodeP2P({
          uniqName: c.uniqName ?? `p2p_${i + 1}`,
          peers: c.peers,
          maxPeers: c.maxPeers,
          connectionTimeout: c.connectionTimeout,
          network,
        });
      });

    const buildNetworkProviders = () => buildTransports(networkProviders).map((t) => new NetworkProvider(t));

    const buildMempoolProviders = () => buildTransports(mempoolProviders).map((t) => new MempoolProvider(t));

    const providers = [
      {
        provide: NetworkConnectionManager,
        useFactory: async () => {
          const provs = buildNetworkProviders();
          const cmLogger = new Logger(NetworkConnectionManager.name);
          const cm = new NetworkConnectionManager({ providers: provs, logger: cmLogger });
          if (provs.length) {
            try {
              await cm.initialize();
            } catch (error) {
              logger.debug('Failed to initialize network connection manager', {
                module: moduleName,
                args: { error: (error as Error).message },
              });
              throw error;
            }
          }
          return cm;
        },
        inject: [],
      },
      {
        provide: MempoolConnectionManager,
        useFactory: async () => {
          const provs = buildMempoolProviders();
          const cmLogger = new Logger(MempoolConnectionManager.name);
          const cm = new MempoolConnectionManager({ providers: provs, logger: cmLogger });
          if (provs.length) {
            try {
              await cm.initialize();
            } catch (error) {
              logger.debug('Failed to initialize mempool connection manager', {
                module: moduleName,
                args: { error: (error as Error).message },
              });
              throw error;
            }
          }
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
