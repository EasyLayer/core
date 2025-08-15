import type { AppLogger } from '@easylayer/common/logger';
import type { NetworkProvider, MempoolProvider } from '../providers';
import { NetworkConnectionManager, MempoolConnectionManager } from '../managers';
import { ProviderFactory } from './providers-factory';
import type { TransportConfig } from './transports-factory';
import type { NetworkConfig, RateLimits } from '../transports';

export interface ModuleProviderConfig {
  type: 'rpc' | 'p2p';
  connections: ProviderConnectionConfig[];
}

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

// Type for module provider configuration (from module)
// export interface ModuleProviderConfig {
//   type: 'rpc' | 'p2p';
//   connections: Array<{
//     baseUrl?: string;
//     peers?: Array<{ host: string; port: number }>;
//     uniqName?: string;
//     responseTimeout?: number;
//     zmqEndpoint?: string;
//     maxPeers?: number;
//     connectionTimeout?: number;
//     defaultStrategy?: 'parallel' | 'round-robin' | 'fastest';
//   }>;
//   // defaultStrategy?: 'parallel' | 'round-robin' | 'fastest';
// }

export class ConnectionManagerFactory {
  /**
   * Create network connection manager with single active provider strategy
   */
  static createNetworkConnectionManager(providers: NetworkProvider[], logger: AppLogger): NetworkConnectionManager {
    return new NetworkConnectionManager({ providers, logger });
  }

  /**
   * Create mempool connection manager with multiple provider strategy
   */
  static createMempoolConnectionManager(providers: MempoolProvider[], logger: AppLogger): MempoolConnectionManager {
    return new MempoolConnectionManager({ providers, logger });
  }

  /**
   * Create network connection manager from transport configurations
   */
  static createNetworkConnectionManagerFromConfigs(
    configs: TransportConfig[],
    logger: AppLogger
  ): NetworkConnectionManager {
    const providers = ProviderFactory.createNetworkProviders(configs);
    return this.createNetworkConnectionManager(providers, logger);
  }

  /**
   * Create mempool connection manager from transport configurations
   */
  static createMempoolConnectionManagerFromConfigs(
    configs: TransportConfig[],
    logger: AppLogger
  ): MempoolConnectionManager {
    const providers = ProviderFactory.createMempoolProviders(configs);
    return this.createMempoolConnectionManager(providers, logger);
  }

  /**
   * Create network providers from module provider configuration
   */
  static createNetworkProvidersFromConfig(
    config: ModuleProviderConfig,
    network: NetworkConfig,
    rateLimits: RateLimits
  ): NetworkProvider[] {
    const transportConfigs = this.convertModuleConfigToTransportConfigs(config, network, rateLimits);
    return ProviderFactory.createNetworkProviders(transportConfigs);
  }

  /**
   * Create mempool providers from module provider configuration
   */
  static createMempoolProvidersFromConfig(
    config: ModuleProviderConfig,
    network: NetworkConfig,
    rateLimits: RateLimits
  ): MempoolProvider[] {
    const transportConfigs = this.convertModuleConfigToTransportConfigs(config, network, rateLimits);
    return ProviderFactory.createMempoolProviders(transportConfigs);
  }

  /**
   * Create network connection manager from RPC URLs
   */
  static createNetworkConnectionManagerFromRPCUrls(
    urls: string[],
    options: {
      network: NetworkConfig;
      rateLimits: RateLimits;
      responseTimeout?: number;
      zmqEndpoint?: string;
    },
    logger: AppLogger
  ): NetworkConnectionManager {
    const providers = ProviderFactory.createNetworkProvidersFromRPCUrls(urls, options);
    return this.createNetworkConnectionManager(providers, logger);
  }

  /**
   * Create mempool connection manager from RPC URLs
   */
  static createMempoolConnectionManagerFromRPCUrls(
    urls: string[],
    options: {
      network: NetworkConfig;
      rateLimits: RateLimits;
      responseTimeout?: number;
      zmqEndpoint?: string;
    },
    logger: AppLogger
  ): MempoolConnectionManager {
    const providers = ProviderFactory.createMempoolProvidersFromRPCUrls(urls, options);
    return this.createMempoolConnectionManager(providers, logger);
  }

  /**
   * Create network connection manager from P2P peers
   */
  static createNetworkConnectionManagerFromP2PPeers(
    peersArray: Array<Array<{ host: string; port: number }>>,
    options: {
      network: NetworkConfig;
      rateLimits: RateLimits;
      maxPeers?: number;
      connectionTimeout?: number;
    },
    logger: AppLogger
  ): NetworkConnectionManager {
    const providers = ProviderFactory.createNetworkProvidersFromP2PPeers(peersArray, options);
    return this.createNetworkConnectionManager(providers, logger);
  }

  /**
   * Create mempool connection manager from P2P peers
   */
  static createMempoolConnectionManagerFromP2PPeers(
    peersArray: Array<Array<{ host: string; port: number }>>,
    options: {
      network: NetworkConfig;
      rateLimits: RateLimits;
      maxPeers?: number;
      connectionTimeout?: number;
    },
    logger: AppLogger
  ): MempoolConnectionManager {
    const providers = ProviderFactory.createMempoolProvidersFromP2PPeers(peersArray, options);
    return this.createMempoolConnectionManager(providers, logger);
  }

  /**
   * Convert module provider configuration to transport configurations
   * This method handles the conversion and validation logic
   */
  private static convertModuleConfigToTransportConfigs(
    config: ModuleProviderConfig,
    network: NetworkConfig,
    rateLimits: RateLimits
  ): TransportConfig[] {
    return config.connections.map((connection, index) => {
      const baseConfig = {
        network,
        rateLimits,
        uniqName: connection.uniqName,
      };

      switch (config.type) {
        case 'rpc':
          if (!connection.baseUrl) {
            throw new Error(`RPC provider connection ${index}: baseUrl is required for RPC type`);
          }

          return {
            type: 'rpc' as const,
            baseUrl: connection.baseUrl,
            responseTimeout: connection.responseTimeout,
            zmqEndpoint: connection.zmqEndpoint,
            ...baseConfig,
          };

        case 'p2p':
          if (!connection.peers || !Array.isArray(connection.peers) || connection.peers.length === 0) {
            throw new Error(`P2P provider connection ${index}: peers array is required for P2P type`);
          }

          return {
            type: 'p2p' as const,
            peers: connection.peers,
            maxPeers: connection.maxPeers,
            connectionTimeout: connection.connectionTimeout,
            ...baseConfig,
          };

        default:
          throw new Error(`Unsupported transport type: ${(config as any).type}`);
      }
    });
  }
}
