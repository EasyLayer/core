import { ConnectionManager } from '../connection-manager';
import { BaseNodeProvider } from '../node-providers/base-node-provider';

// Mock dependencies
const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as jest.Mocked<any>;

// Mock provider for ConnectionManager tests
class MockProvider extends BaseNodeProvider {
  type = 'mock';
  private connected = false;
  private healthy = true;

  get connectionOptions() {
    return { uniqName: this.uniqName };
  }

  async connect(): Promise<void> {
    if (!this.healthy) {
      throw new Error('Connection failed');
    }
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async healthcheck(): Promise<boolean> {
    return this.healthy && this.connected;
  }

  async healthcheckWebSocket(): Promise<boolean> {
    return this.healthy && this.connected;
  }

  async reconnectWebSocket(): Promise<void> {
    if (!this.healthy) {
      throw new Error('Reconnection failed');
    }
  }

  setHealthy(healthy: boolean) {
    this.healthy = healthy;
  }

  get wsClient() {
    return this.connected ? { on: jest.fn(), off: jest.fn() } : null;
  }
}

describe('ConnectionManager', () => {
  let connectionManager: ConnectionManager;
  let mockProvider1: MockProvider;
  let mockProvider2: MockProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    mockProvider1 = new MockProvider({ uniqName: 'provider1' });
    mockProvider2 = new MockProvider({ uniqName: 'provider2' });
    
    connectionManager = new ConnectionManager(
      [mockProvider1, mockProvider2],
      mockLogger,
      { enabled: false } // Disable auto-reconnect for tests
    );
  });

  describe('constructor', () => {
    it('should register providers correctly', () => {
      expect(connectionManager.providers.size).toBe(2);
      expect(connectionManager.providers.has('provider1')).toBe(true);
      expect(connectionManager.providers.has('provider2')).toBe(true);
    });

    it('should throw error for duplicate provider names', () => {
      const duplicateProvider = new MockProvider({ uniqName: 'provider1' });
      
      expect(() => {
        new ConnectionManager([mockProvider1, duplicateProvider], mockLogger);
      }).toThrow('An adapter with the name "provider1" has already been added.');
    });
  });

  describe('onModuleInit', () => {
    it('should connect to first available provider', async () => {
      await connectionManager.onModuleInit();

      const activeProvider = await connectionManager.getActiveProvider();
      expect(activeProvider.uniqName).toBe('provider1');
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Connected to provider: MockProvider',
        expect.objectContaining({ args: { activeProviderName: 'provider1' } })
      );
    });

    it('should try backup provider when first fails', async () => {
      mockProvider1.setHealthy(false);

      await connectionManager.onModuleInit();

      const activeProvider = await connectionManager.getActiveProvider();
      expect(activeProvider.uniqName).toBe('provider2');
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Provider connect failed, trying next',
        expect.objectContaining({ args: { providerName: 'provider1' } })
      );
    });

    it('should throw error when no providers can connect', async () => {
      mockProvider1.setHealthy(false);
      mockProvider2.setHealthy(false);

      await expect(connectionManager.onModuleInit()).rejects.toThrow(
        'Unable to connect to any providers.'
      );
    });
  });

  describe('switchProvider', () => {
    beforeEach(async () => {
      await connectionManager.onModuleInit();
    });

    it('should successfully switch to different provider', async () => {
      await connectionManager.switchProvider('provider2');

      const activeProvider = await connectionManager.getActiveProvider();
      expect(activeProvider.uniqName).toBe('provider2');
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Switched to provider: MockProvider',
        expect.objectContaining({ args: { name: 'provider2' } })
      );
    });

    it('should throw error when switching to non-existent provider', async () => {
      await expect(connectionManager.switchProvider('nonexistent')).rejects.toThrow(
        'Provider with name nonexistent not found'
      );
    });

    it('should throw error when target provider fails to connect', async () => {
      mockProvider2.setHealthy(false);

      await expect(connectionManager.switchProvider('provider2')).rejects.toThrow(
        'Failed to switch to provider with name provider2'
      );
    });
  });

  describe('getProviderByName', () => {
    beforeEach(async () => {
      await connectionManager.onModuleInit();
    });

    it('should return already active provider without reconnecting', async () => {
      const provider = await connectionManager.getProviderByName('provider1');

      expect(provider.uniqName).toBe('provider1');
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Requested provider is already active',
        expect.objectContaining({ args: { name: 'provider1' } })
      );
    });

    it('should connect to inactive provider and switch active provider', async () => {
      const provider = await connectionManager.getProviderByName('provider2');

      expect(provider.uniqName).toBe('provider2');
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Connected to adapter: MockProvider',
        expect.objectContaining({ args: { name: 'provider2' } })
      );
    });

    it('should throw error when provider fails to connect', async () => {
      mockProvider2.setHealthy(false);

      await expect(connectionManager.getProviderByName('provider2')).rejects.toThrow(
        'Failed to connect to provider with name provider2'
      );
    });
  });

  describe('onModuleDestroy', () => {
    it('should disconnect all providers', async () => {
      await connectionManager.onModuleInit();
      
      const disconnectSpy1 = jest.spyOn(mockProvider1, 'disconnect');
      const disconnectSpy2 = jest.spyOn(mockProvider2, 'disconnect');

      await connectionManager.onModuleDestroy();

      expect(disconnectSpy1).toHaveBeenCalled();
      expect(disconnectSpy2).toHaveBeenCalled();
    });
  });

  describe('removeProvider', () => {
    it('should remove existing provider', () => {
      const result = connectionManager.removeProvider('provider1');

      expect(result).toBe(true);
      expect(connectionManager.providers.has('provider1')).toBe(false);
    });

    it('should throw error when removing non-existent provider', () => {
      expect(() => {
        connectionManager.removeProvider('nonexistent');
      }).toThrow('Provider with name nonexistent not found');
    });
  });
});