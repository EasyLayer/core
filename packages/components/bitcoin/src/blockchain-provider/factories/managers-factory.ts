import type { AppLogger } from '@easylayer/common/logger';
import type { NetworkProvider, MempoolProvider } from '../providers';
import { NetworkConnectionManager, MempoolConnectionManager } from '../managers';
import { ProviderFactory } from './providers-factory';
import type { TransportConfig } from './transports-factory';
import type { NetworkConfig, RateLimits } from '../transports';

// Type for module provider configuration (from module)
export interface ModuleProviderConfig {
  type: 'RPC' | 'P2P';
  connections: Array<{
    baseUrl?: string;
    peers?: Array<{ host: string; port: number }>;
    uniqName?: string;
    responseTimeout?: number;
    zmqEndpoint?: string;
    maxPeers?: number;
    connectionTimeout?: number;
    maxBatchSize?: number;
  }>;
  defaultStrategy?: 'parallel' | 'round-robin' | 'fastest';
}

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
      maxBatchSize?: number;
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
      maxBatchSize?: number;
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
        case 'RPC':
          if (!connection.baseUrl) {
            throw new Error(`RPC provider connection ${index}: baseUrl is required for RPC type`);
          }

          return {
            type: 'RPC' as const,
            baseUrl: connection.baseUrl,
            responseTimeout: connection.responseTimeout,
            zmqEndpoint: connection.zmqEndpoint,
            ...baseConfig,
          };

        case 'P2P':
          if (!connection.peers || !Array.isArray(connection.peers) || connection.peers.length === 0) {
            throw new Error(`P2P provider connection ${index}: peers array is required for P2P type`);
          }

          return {
            type: 'P2P' as const,
            peers: connection.peers,
            maxPeers: connection.maxPeers,
            connectionTimeout: connection.connectionTimeout,
            maxBatchSize: connection.maxBatchSize,
            ...baseConfig,
          };

        default:
          throw new Error(`Unsupported provider type: ${(config as any).type}`);
      }
    });
  }
}
