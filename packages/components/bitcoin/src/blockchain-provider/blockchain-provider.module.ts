import { Module, DynamicModule } from '@nestjs/common';
import { LoggerModule, AppLogger } from '@easylayer/common/logger';
import { BlockchainProviderService } from './blockchain-provider.service';
import { NetworkConnectionManager, MempoolConnectionManager } from './managers';
import { ConnectionManagerFactory } from './factories';
import { KeyManagementService, ScriptUtilService, WalletService, TransactionService } from './utils';
import type { NetworkConfig, RateLimits } from './transports';

/**
 * Provider configuration for blockchain module
 * Each provider config contains connections of the same type (all RPC or all P2P)
 */
export interface ProviderConfig {
  /** Provider type - must be same for all connections in this config */
  type: 'RPC' | 'P2P';
  /** Array of connection endpoints/configurations */
  connections: ProviderConnectionConfig[];
}

/**
 * Individual connection configuration within a provider
 * Contains transport-specific options
 */
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
  /** Maximum batch size for requests (default: 2000, max: 2000) */
  maxBatchSize?: number;

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
}

/**
 * Main configuration for blockchain provider module
 */
export interface BlockchainProviderModuleOptions {
  /** Network providers configuration (for blocks, transactions, blockchain info) */
  networkProviders: ProviderConfig;
  /** Mempool providers configuration (for mempool operations) */
  mempoolProviders: ProviderConfig;
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
  /**
   * Create blockchain provider module with async initialization
   *
   * @param options Module configuration
   * @returns Dynamic NestJS module
   */
  static async forRootAsync(options: BlockchainProviderModuleOptions): Promise<DynamicModule> {
    const { networkProviders, mempoolProviders, network, rateLimits, isGlobal } = options;

    const providers = [];
    const exports: any = [KeyManagementService, ScriptUtilService, WalletService, TransactionService];

    // Network Connection Manager (always created, even with empty providers array)
    // Handles single active provider with automatic failover
    providers.push({
      provide: NetworkConnectionManager,
      useFactory: async (logger: AppLogger) => {
        const networkProviderInstances =
          networkProviders.connections.length > 0
            ? ConnectionManagerFactory.createNetworkProvidersFromConfig(networkProviders, network, rateLimits)
            : [];

        const connectionManager = ConnectionManagerFactory.createNetworkConnectionManager(
          networkProviderInstances,
          logger
        );

        // Initialize if providers are available
        // P2P providers will start header sync in background
        if (networkProviderInstances.length > 0) {
          await connectionManager.initialize();
        }

        return connectionManager;
      },
      inject: [AppLogger],
    });

    // Mempool Connection Manager (always created, even with empty providers array)
    // Handles multiple providers with configurable strategies (parallel, round-robin, fastest)
    providers.push({
      provide: MempoolConnectionManager,
      useFactory: async (logger: AppLogger) => {
        const mempoolProviderInstances =
          mempoolProviders.connections.length > 0
            ? ConnectionManagerFactory.createMempoolProvidersFromConfig(mempoolProviders, network, rateLimits)
            : [];

        const connectionManager = ConnectionManagerFactory.createMempoolConnectionManager(
          mempoolProviderInstances,
          logger
        );

        // Initialize all mempool providers in parallel
        if (mempoolProviderInstances.length > 0) {
          await connectionManager.initialize();
        }

        return connectionManager;
      },
      inject: [AppLogger],
    });

    // Main Blockchain Provider Service (always created)
    // Provides unified interface with automatic normalization and error handling
    providers.push({
      provide: BlockchainProviderService,
      useFactory: (
        logger: AppLogger,
        networkConnectionManager: NetworkConnectionManager,
        mempoolConnectionManager: MempoolConnectionManager
      ) => {
        return new BlockchainProviderService(logger, networkConnectionManager, mempoolConnectionManager, network);
      },
      inject: [AppLogger, NetworkConnectionManager, MempoolConnectionManager],
    });

    // Utility Services for wallet operations, key management, etc.
    providers.push(KeyManagementService, ScriptUtilService, WalletService, TransactionService);

    // Export all services for use in other modules
    exports.push(BlockchainProviderService, NetworkConnectionManager, MempoolConnectionManager);

    return {
      module: BlockchainProviderModule,
      global: isGlobal || false,
      imports: [LoggerModule.forRoot({ componentName: BlockchainProviderModule.name })],
      providers,
      exports,
    };
  }
}
