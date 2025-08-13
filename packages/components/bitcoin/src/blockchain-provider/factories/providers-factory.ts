import type { BaseTransport, NetworkConfig, RateLimits } from '../transports';
import type { NetworkProvider, MempoolProvider } from '../providers';
import { NetworkProvider as NetworkProviderClass, MempoolProvider as MempoolProviderClass } from '../providers';
import type { TransportConfig } from './transports-factory';
import { TransportFactory } from './transports-factory';

export const PROVIDER_TYPES = {
  NETWORK: 'network',
  MEMPOOL: 'mempool',
} as const;

export type ProviderType = (typeof PROVIDER_TYPES)[keyof typeof PROVIDER_TYPES];

// Type mapping for provider types to provider instances
type ProviderTypeMap = {
  [PROVIDER_TYPES.NETWORK]: NetworkProvider;
  [PROVIDER_TYPES.MEMPOOL]: MempoolProvider;
};

export class ProviderFactory {
  /**
   * Create provider instance with transport and proper typing
   */
  static createProvider<T extends ProviderType>(type: T, transport: BaseTransport): ProviderTypeMap[T] {
    switch (type) {
      case PROVIDER_TYPES.NETWORK:
        return new NetworkProviderClass(transport) as ProviderTypeMap[T];

      case PROVIDER_TYPES.MEMPOOL:
        return new MempoolProviderClass(transport) as ProviderTypeMap[T];

      default:
        throw new Error(`Unsupported provider type: ${type}`);
    }
  }

  /**
   * Create multiple providers of same type with different transports
   */
  static createMultipleProviders<T extends ProviderType>(type: T, transports: BaseTransport[]): ProviderTypeMap[T][] {
    return transports.map((transport) => this.createProvider(type, transport));
  }

  /**
   * Create network providers from transport configurations
   */
  static createNetworkProviders(configs: TransportConfig[]): NetworkProvider[] {
    const transports = TransportFactory.createMultipleTransports(configs);
    return this.createMultipleProviders(PROVIDER_TYPES.NETWORK, transports);
  }

  /**
   * Create mempool providers from transport configurations
   */
  static createMempoolProviders(configs: TransportConfig[]): MempoolProvider[] {
    const transports = TransportFactory.createMultipleTransports(configs);
    return this.createMultipleProviders(PROVIDER_TYPES.MEMPOOL, transports);
  }

  /**
   * Create network providers from RPC URLs
   */
  static createNetworkProvidersFromRPCUrls(
    urls: string[],
    options: {
      network: NetworkConfig;
      rateLimits: RateLimits;
      responseTimeout?: number;
      zmqEndpoint?: string;
    }
  ): NetworkProvider[] {
    const transports = TransportFactory.createRPCTransportsFromUrls(urls, options);
    return this.createMultipleProviders(PROVIDER_TYPES.NETWORK, transports);
  }

  /**
   * Create mempool providers from RPC URLs
   */
  static createMempoolProvidersFromRPCUrls(
    urls: string[],
    options: {
      network: NetworkConfig;
      rateLimits: RateLimits;
      responseTimeout?: number;
      zmqEndpoint?: string;
    }
  ): MempoolProvider[] {
    const transports = TransportFactory.createRPCTransportsFromUrls(urls, options);
    return this.createMultipleProviders(PROVIDER_TYPES.MEMPOOL, transports);
  }

  /**
   * Create network providers from P2P peers
   */
  static createNetworkProvidersFromP2PPeers(
    peersArray: Array<Array<{ host: string; port: number }>>,
    options: {
      network: NetworkConfig;
      rateLimits: RateLimits;
      maxPeers?: number;
      connectionTimeout?: number;
      maxBatchSize?: number;
    }
  ): NetworkProvider[] {
    const transports = TransportFactory.createP2PTransportsFromPeers(peersArray, options);
    return this.createMultipleProviders(PROVIDER_TYPES.NETWORK, transports);
  }

  /**
   * Create mempool providers from P2P peers
   */
  static createMempoolProvidersFromP2PPeers(
    peersArray: Array<Array<{ host: string; port: number }>>,
    options: {
      network: NetworkConfig;
      rateLimits: RateLimits;
      maxPeers?: number;
      connectionTimeout?: number;
      maxBatchSize?: number;
    }
  ): MempoolProvider[] {
    const transports = TransportFactory.createP2PTransportsFromPeers(peersArray, options);
    return this.createMultipleProviders(PROVIDER_TYPES.MEMPOOL, transports);
  }

  /**
   * Create network provider from single RPC URL
   */
  static createNetworkProviderFromRPCUrl(
    url: string,
    options: {
      network: NetworkConfig;
      rateLimits: RateLimits;
      uniqName?: string;
      responseTimeout?: number;
      zmqEndpoint?: string;
    }
  ): NetworkProvider {
    const transport = TransportFactory.createRPCTransport(url, options);
    return this.createProvider(PROVIDER_TYPES.NETWORK, transport);
  }

  /**
   * Create mempool provider from single RPC URL
   */
  static createMempoolProviderFromRPCUrl(
    url: string,
    options: {
      network: NetworkConfig;
      rateLimits: RateLimits;
      uniqName?: string;
      responseTimeout?: number;
      zmqEndpoint?: string;
    }
  ): MempoolProvider {
    const transport = TransportFactory.createRPCTransport(url, options);
    return this.createProvider(PROVIDER_TYPES.MEMPOOL, transport);
  }

  /**
   * Create network provider from P2P peers
   */
  static createNetworkProviderFromP2PPeers(
    peers: Array<{ host: string; port: number }>,
    options: {
      network: NetworkConfig;
      rateLimits: RateLimits;
      uniqName?: string;
      maxPeers?: number;
      connectionTimeout?: number;
      maxBatchSize?: number;
    }
  ): NetworkProvider {
    const transport = TransportFactory.createP2PTransport(peers, options);
    return this.createProvider(PROVIDER_TYPES.NETWORK, transport);
  }

  /**
   * Create mempool provider from P2P peers
   */
  static createMempoolProviderFromP2PPeers(
    peers: Array<{ host: string; port: number }>,
    options: {
      network: NetworkConfig;
      rateLimits: RateLimits;
      uniqName?: string;
      maxPeers?: number;
      connectionTimeout?: number;
      maxBatchSize?: number;
    }
  ): MempoolProvider {
    const transport = TransportFactory.createP2PTransport(peers, options);
    return this.createProvider(PROVIDER_TYPES.MEMPOOL, transport);
  }
}
