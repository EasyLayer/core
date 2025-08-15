import { v4 as uuidv4 } from 'uuid';
import type { BaseTransport, NetworkConfig, RateLimits } from '../transports';
import { RPCTransport as RPCTransportClass, P2PTransport as P2PTransportClass } from '../transports';

export const TRANSPORT_TYPES = {
  RPC: 'rpc',
  P2P: 'p2p',
} as const;

export type TransportType = (typeof TRANSPORT_TYPES)[keyof typeof TRANSPORT_TYPES];

export interface BaseTransportConfig {
  type: TransportType;
  uniqName?: string;
  rateLimits: RateLimits;
  network: NetworkConfig;
}

export interface RPCTransportConfig extends BaseTransportConfig {
  type: 'rpc';
  baseUrl: string;
  responseTimeout?: number;
  zmqEndpoint?: string;
}

export interface P2PTransportConfig extends BaseTransportConfig {
  type: 'p2p';
  peers: Array<{ host: string; port: number }>;
  maxPeers?: number;
  connectionTimeout?: number;
  maxHeight?: number;
  headerSyncEnabled?: boolean;
  headerSyncBatchSize?: number;
}

// Required config types (with mandatory uniqName)
export interface RPCTransportRequiredConfig extends Omit<RPCTransportConfig, 'uniqName'> {
  uniqName: string;
}

export interface P2PTransportRequiredConfig extends Omit<P2PTransportConfig, 'uniqName'> {
  uniqName: string;
}

export type TransportConfig = RPCTransportConfig | P2PTransportConfig;

// Type mapping for transport configurations
type TransportTypeMap = {
  [TRANSPORT_TYPES.RPC]: RPCTransportConfig;
  [TRANSPORT_TYPES.P2P]: P2PTransportConfig;
};

// Type mapping for transport instances
type TransportInstanceMap = {
  [TRANSPORT_TYPES.RPC]: RPCTransportClass;
  [TRANSPORT_TYPES.P2P]: P2PTransportClass;
};

export class TransportFactory {
  /**
   * Create transport instance from configuration with proper type validation
   */
  static createTransport(config: TransportConfig): BaseTransport {
    // Validate configuration first
    this.validateAndThrowConfig(config);

    // Generate unique name if not provided
    const uniqName = config.uniqName || `${config.type.toUpperCase()}_${uuidv4().slice(0, 8)}`;

    const baseConfig = {
      ...config,
      uniqName,
    };

    switch (config.type) {
      case TRANSPORT_TYPES.RPC: {
        const rpcConfig = baseConfig as RPCTransportConfig & { uniqName: string };
        return new RPCTransportClass(rpcConfig);
      }

      case TRANSPORT_TYPES.P2P: {
        const p2pConfig = baseConfig as P2PTransportConfig & { uniqName: string };
        return new P2PTransportClass(p2pConfig);
      }

      default:
        throw new Error(`Unsupported transport type: ${(config as any).type}`);
    }
  }

  /**
   * Create transport instance with proper typing (generic version)
   */
  static createTypedTransport<T extends TransportType>(config: TransportTypeMap[T]): TransportInstanceMap[T] {
    const transport = this.createTransport(config);
    return transport as TransportInstanceMap[T];
  }

  /**
   * Create multiple transports from array of configurations
   */
  static createMultipleTransports(configs: TransportConfig[]): BaseTransport[] {
    return configs.map((config) => this.createTransport(config));
  }

  /**
   * Create RPC transport from URL with validation
   */
  static createRPCTransport(
    baseUrl: string,
    options: {
      network: NetworkConfig;
      rateLimits: RateLimits;
      uniqName?: string;
      responseTimeout?: number;
      zmqEndpoint?: string;
    }
  ): RPCTransportClass {
    const config: RPCTransportConfig = {
      type: TRANSPORT_TYPES.RPC,
      baseUrl,
      uniqName: options.uniqName || `RPC_${uuidv4().slice(0, 8)}`,
      network: options.network,
      rateLimits: options.rateLimits,
      responseTimeout: options.responseTimeout,
      zmqEndpoint: options.zmqEndpoint,
    };

    return this.createTransport(config) as RPCTransportClass;
  }

  /**
   * Create P2P transport from peers with validation
   */
  static createP2PTransport(
    peers: Array<{ host: string; port: number }>,
    options: {
      network: NetworkConfig;
      rateLimits: RateLimits;
      uniqName?: string;
      maxPeers?: number;
      connectionTimeout?: number;
    }
  ): P2PTransportClass {
    const config: P2PTransportConfig = {
      type: TRANSPORT_TYPES.P2P,
      peers,
      uniqName: options.uniqName || `P2P_${uuidv4().slice(0, 8)}`,
      network: options.network,
      rateLimits: options.rateLimits,
      maxPeers: options.maxPeers,
      connectionTimeout: options.connectionTimeout,
    };

    return this.createTransport(config) as P2PTransportClass;
  }

  /**
   * Create multiple RPC transports from URLs array
   */
  static createRPCTransportsFromUrls(
    urls: string[],
    options: {
      network: NetworkConfig;
      rateLimits: RateLimits;
      responseTimeout?: number;
      zmqEndpoint?: string;
    }
  ): RPCTransportClass[] {
    return urls.map((url, index) => {
      return this.createRPCTransport(url, {
        ...options,
        uniqName: `RPC_${index + 1}_${uuidv4().slice(0, 8)}`,
      });
    });
  }

  /**
   * Create multiple P2P transports from peers array
   */
  static createP2PTransportsFromPeers(
    peersArray: Array<Array<{ host: string; port: number }>>,
    options: {
      network: NetworkConfig;
      rateLimits: RateLimits;
      maxPeers?: number;
      connectionTimeout?: number;
    }
  ): P2PTransportClass[] {
    return peersArray.map((peers, index) => {
      return this.createP2PTransport(peers, {
        ...options,
        uniqName: `P2P_${index + 1}_${uuidv4().slice(0, 8)}`,
      });
    });
  }

  /**
   * Validate transport configuration and throw detailed errors
   */
  private static validateAndThrowConfig(config: TransportConfig): void {
    if (!config.type) {
      throw new Error('Transport configuration must specify a type');
    }

    if (!config.network) {
      throw new Error('Transport configuration must specify network configuration');
    }

    if (!config.rateLimits) {
      throw new Error('Transport configuration must specify rate limits');
    }

    switch (config.type) {
      case TRANSPORT_TYPES.RPC:
        this.validateRPCConfig(config as RPCTransportConfig);
        break;

      case TRANSPORT_TYPES.P2P:
        this.validateP2PConfig(config as P2PTransportConfig);
        break;

      default:
        throw new Error(`Unsupported transport type: ${(config as any).type}`);
    }
  }

  /**
   * Validate RPC transport configuration
   */
  private static validateRPCConfig(config: RPCTransportConfig): void {
    if (!config.baseUrl || typeof config.baseUrl !== 'string') {
      throw new Error('RPC transport configuration must specify a valid baseUrl');
    }

    try {
      new URL(config.baseUrl);
    } catch (error) {
      throw new Error(`RPC transport baseUrl must be a valid URL: ${config.baseUrl}`);
    }

    if (
      config.responseTimeout !== undefined &&
      (typeof config.responseTimeout !== 'number' || config.responseTimeout <= 0)
    ) {
      throw new Error('RPC transport responseTimeout must be a positive number');
    }

    if (config.zmqEndpoint !== undefined && typeof config.zmqEndpoint !== 'string') {
      throw new Error('RPC transport zmqEndpoint must be a string');
    }
  }

  /**
   * Validate P2P transport configuration
   */
  private static validateP2PConfig(config: P2PTransportConfig): void {
    if (!Array.isArray(config.peers) || config.peers.length === 0) {
      throw new Error('P2P transport configuration must specify a non-empty peers array');
    }

    config.peers.forEach((peer, index) => {
      if (!peer.host || typeof peer.host !== 'string') {
        throw new Error(`P2P transport peer ${index}: host must be a non-empty string`);
      }

      if (typeof peer.port !== 'number' || peer.port <= 0 || peer.port > 65535) {
        throw new Error(`P2P transport peer ${index}: port must be a valid port number (1-65535)`);
      }
    });

    if (config.maxPeers !== undefined && (typeof config.maxPeers !== 'number' || config.maxPeers <= 0)) {
      throw new Error('P2P transport maxPeers must be a positive number');
    }

    if (
      config.connectionTimeout !== undefined &&
      (typeof config.connectionTimeout !== 'number' || config.connectionTimeout <= 0)
    ) {
      throw new Error('P2P transport connectionTimeout must be a positive number');
    }
  }

  /**
   * Check if configuration is valid without throwing
   */
  static isValidConfig(config: TransportConfig): boolean {
    try {
      this.validateAndThrowConfig(config);
      return true;
    } catch (error) {
      return false;
    }
  }
}
