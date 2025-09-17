import { Module, DynamicModule } from '@nestjs/common';
import { BlockchainProviderService } from './blockchain-provider.service';
import { NetworkConnectionManager, MempoolConnectionManager } from './managers';
import { ConnectionManagerFactory, ModuleProviderConfig } from './factories';
import { KeyManagementService, ScriptUtilService, WalletService, TransactionService } from './utils';
import type { NetworkConfig, RateLimits } from './transports';

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
      useFactory: async () => {
        const hasConns = (networkProviders?.connections?.length ?? 0) > 0;

        const networkProviderInstances = hasConns
          ? ConnectionManagerFactory.createNetworkProvidersFromConfig(networkProviders, network, rateLimits)
          : [];

        const connectionManager = ConnectionManagerFactory.createNetworkConnectionManager(networkProviderInstances);

        // Initialize if providers are available
        // P2P providers will start header sync in background
        if (networkProviderInstances.length > 0) {
          await connectionManager.initialize();
        }

        return connectionManager;
      },
      inject: [],
    });

    // Mempool Connection Manager (always created, even with empty providers array)
    // Handles multiple providers with configurable strategies (parallel, round-robin, fastest)
    providers.push({
      provide: MempoolConnectionManager,
      useFactory: async () => {
        const hasConns = (mempoolProviders?.connections?.length ?? 0) > 0;

        const mempoolProviderInstances = hasConns
          ? ConnectionManagerFactory.createMempoolProvidersFromConfig(mempoolProviders, network, rateLimits)
          : [];

        const connectionManager = ConnectionManagerFactory.createMempoolConnectionManager(mempoolProviderInstances);

        // Initialize all mempool providers in parallel
        if (mempoolProviderInstances.length > 0) {
          await connectionManager.initialize();
        }

        return connectionManager;
      },
      inject: [],
    });

    // Main Blockchain Provider Service (always created)
    // Provides unified interface with automatic normalization and error handling
    providers.push({
      provide: BlockchainProviderService,
      useFactory: (
        networkConnectionManager: NetworkConnectionManager,
        mempoolConnectionManager: MempoolConnectionManager
      ) => {
        return new BlockchainProviderService(networkConnectionManager, mempoolConnectionManager, network);
      },
      inject: [NetworkConnectionManager, MempoolConnectionManager],
    });

    // Utility Services for wallet operations, key management, etc.
    providers.push(KeyManagementService, ScriptUtilService, WalletService, TransactionService);

    // Export all services for use in other modules
    exports.push(BlockchainProviderService, NetworkConnectionManager, MempoolConnectionManager);

    return {
      module: BlockchainProviderModule,
      global: isGlobal || false,
      imports: [],
      providers,
      exports,
    };
  }
}
