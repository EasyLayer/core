import { ConnectionManager } from '../connection-manager';
import { BaseNodeProvider } from '../node-providers/base-node-provider';

// Mock the exponential interval library
jest.mock('@easylayer/common/exponential-interval-async', () => ({
  exponentialIntervalAsync: jest.fn()
}));

import { exponentialIntervalAsync } from '@easylayer/common/exponential-interval-async';

// Mock dependencies
const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as jest.Mocked<any>;

// Create a controllable mock timer
let currentMockTimer: any = null;

const createMockTimer = () => {
  let callback: ((resetFn: () => void) => Promise<void>) | null = null;
  let destroyed = false;

  const mockTimer = {
    destroy: jest.fn(() => {
      destroyed = true;
    }),
    
    // Helper methods for testing
    triggerCallback: async () => {
      if (callback && !destroyed) {
        const resetFn = jest.fn();
        await callback(resetFn);
        return resetFn;
      }
      return null;
    },
    
    isDestroyed: () => destroyed
  };

  // Mock implementation that stores the callback
  (exponentialIntervalAsync as jest.Mock).mockImplementation((asyncFn, options) => {
    callback = asyncFn;
    return mockTimer;
  });

  currentMockTimer = mockTimer;
  return mockTimer;
};

// Mock provider for ConnectionManager tests
class MockProvider extends BaseNodeProvider {
  type = 'mock';
  private connected = false;
  private healthy = true;
  private wsHealthy = true;
  private httpHealthy = true;

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
    return this.httpHealthy && this.connected;
  }

  async healthcheckWebSocket(): Promise<boolean> {
    return this.wsHealthy && this.connected;
  }

  async reconnectWebSocket(): Promise<void> {
    if (!this.wsHealthy) {
      throw new Error('WebSocket reconnection failed');
    }
    this.wsHealthy = true;
  }

  setHealthy(healthy: boolean) {
    this.healthy = healthy;
    this.httpHealthy = healthy;
  }

  setWebSocketHealthy(healthy: boolean) {
    this.wsHealthy = healthy;
  }

  setHttpHealthy(healthy: boolean) {
    this.httpHealthy = healthy;
  }

  get wsClient() {
    return this.connected ? { on: jest.fn(), off: jest.fn() } : null;
  }
}

describe('ConnectionManager', () => {
  let connectionManager: ConnectionManager;
  let mockProvider1: MockProvider;
  let mockProvider2: MockProvider;
  let mockTimer: any;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Create fresh mock timer for each test
    mockTimer = createMockTimer();

    mockProvider1 = new MockProvider({ uniqName: 'provider1' });
    mockProvider2 = new MockProvider({ uniqName: 'provider2' });
    
    // Reset provider states
    mockProvider1.setHealthy(true);
    mockProvider1.setWebSocketHealthy(true);
    mockProvider1.setHttpHealthy(true);
    mockProvider2.setHealthy(true);
    mockProvider2.setWebSocketHealthy(true);
    mockProvider2.setHttpHealthy(true);
  });

  afterEach(() => {
    if (mockTimer && !mockTimer.isDestroyed()) {
      mockTimer.destroy();
    }
  });

  describe('onModuleInit', () => {
    beforeEach(() => {
      connectionManager = new ConnectionManager(
        [mockProvider1, mockProvider2],
        mockLogger,
        { enabled: false }
      );
    });

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
      connectionManager = new ConnectionManager(
        [mockProvider1, mockProvider2],
        mockLogger,
        { enabled: false }
      );
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
      connectionManager = new ConnectionManager(
        [mockProvider1, mockProvider2],
        mockLogger,
        { enabled: false }
      );
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

    it('should return inactive provider without connecting when autoConnect=false', async () => {
      const provider = await connectionManager.getProviderByName('provider2', false);
      
      expect(provider.uniqName).toBe('provider2');
      const activeProvider = await connectionManager.getActiveProvider();
      expect(activeProvider.uniqName).toBe('provider1');
    });

    it('should connect to inactive provider and switch active provider when autoConnect=true', async () => {
      const provider = await connectionManager.getProviderByName('provider2', true);
      
      expect(provider.uniqName).toBe('provider2');
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Connected to provider: MockProvider',
        expect.objectContaining({ args: { name: 'provider2' } })
      );

      const activeProvider = await connectionManager.getActiveProvider();
      expect(activeProvider.uniqName).toBe('provider2');
    });

    it('should throw error when provider fails to connect with autoConnect=true', async () => {
      mockProvider2.setHealthy(false);
      
      await expect(connectionManager.getProviderByName('provider2', true)).rejects.toThrow(
        'Failed to connect to provider with name provider2'
      );
    });

    it('should throw error for non-existent provider', async () => {
      await expect(connectionManager.getProviderByName('nonexistent')).rejects.toThrow(
        'Provider with name nonexistent not found'
      );
    });
  });

  describe('removeProvider', () => {
    beforeEach(async () => {
      connectionManager = new ConnectionManager(
        [mockProvider1, mockProvider2],
        mockLogger,
        { enabled: false }
      );
      await connectionManager.onModuleInit();
    });

    it('should remove non-active provider successfully', async () => {
      const result = await connectionManager.removeProvider('provider2');
      
      expect(result).toBe(true);
      expect(connectionManager.providers.has('provider2')).toBe(false);
      
      const activeProvider = await connectionManager.getActiveProvider();
      expect(activeProvider.uniqName).toBe('provider1');
    });

    it('should switch to backup when removing active provider', async () => {
      const disconnectSpy = jest.spyOn(mockProvider1, 'disconnect');
      
      const result = await connectionManager.removeProvider('provider1');
      
      expect(result).toBe(true);
      expect(connectionManager.providers.has('provider1')).toBe(false);
      expect(disconnectSpy).toHaveBeenCalled();
      
      const activeProvider = await connectionManager.getActiveProvider();
      expect(activeProvider.uniqName).toBe('provider2');
      
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Switched to backup provider after removing active one',
        expect.objectContaining({ 
          args: { removedProvider: 'provider1', newProvider: 'provider2' } 
        })
      );
    });

    it('should clear active provider when removing the only provider', async () => {
      await connectionManager.removeProvider('provider2');
      
      const result = await connectionManager.removeProvider('provider1');
      
      expect(result).toBe(true);
      expect(connectionManager.providers.has('provider1')).toBe(false);
      
      await expect(connectionManager.getActiveProvider()).rejects.toThrow(
        'Provider with name  not found'
      );
    });

    it('should throw error when removing non-existent provider', async () => {
      await expect(connectionManager.removeProvider('nonexistent')).rejects.toThrow(
        'Provider with name nonexistent not found'
      );
    });
  });

  describe('disconnectProvider', () => {
    beforeEach(async () => {
      connectionManager = new ConnectionManager(
        [mockProvider1, mockProvider2],
        mockLogger,
        { enabled: false }
      );
      await connectionManager.onModuleInit();
    });

    it('should disconnect provider successfully', async () => {
      const disconnectSpy = jest.spyOn(mockProvider2, 'disconnect');
      
      await connectionManager.disconnectProvider('provider2');
      
      expect(disconnectSpy).toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Disconnected from provider: MockProvider',
        expect.objectContaining({ args: { name: 'provider2' } })
      );
    });

    it('should stop monitoring when disconnecting active provider', async () => {
      const disconnectSpy = jest.spyOn(mockProvider1, 'disconnect');
      
      await connectionManager.disconnectProvider('provider1');
      
      expect(disconnectSpy).toHaveBeenCalled();
    });

    it('should throw error when disconnecting non-existent provider', async () => {
      await expect(connectionManager.disconnectProvider('nonexistent')).rejects.toThrow(
        'Provider with name nonexistent not found'
      );
    });

    it('should handle disconnect errors', async () => {
      const disconnectSpy = jest.spyOn(mockProvider1, 'disconnect').mockRejectedValue(
        new Error('Disconnect failed')
      );
      
      await expect(connectionManager.disconnectProvider('provider1')).rejects.toThrow(
        'Disconnect failed'
      );
      
      expect(disconnectSpy).toHaveBeenCalled();
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Error disconnecting provider',
        expect.objectContaining({ args: expect.objectContaining({ name: 'provider1' }) })
      );
    });
  });

  describe('onModuleDestroy', () => {
    beforeEach(async () => {
      connectionManager = new ConnectionManager(
        [mockProvider1, mockProvider2],
        mockLogger,
        { enabled: false }
      );
      await connectionManager.onModuleInit();
    });

    it('should disconnect all providers', async () => {
      const disconnectSpy1 = jest.spyOn(mockProvider1, 'disconnect');
      const disconnectSpy2 = jest.spyOn(mockProvider2, 'disconnect');
      
      await connectionManager.onModuleDestroy();
      
      expect(disconnectSpy1).toHaveBeenCalled();
      expect(disconnectSpy2).toHaveBeenCalled();
    });

    it('should handle disconnect errors during cleanup', async () => {
      const disconnectError = new Error('Disconnect failed');
      jest.spyOn(mockProvider1, 'disconnect').mockRejectedValue(disconnectError);
      
      await connectionManager.onModuleDestroy();
      
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Error disconnecting provider during cleanup',
        expect.objectContaining({ 
          args: expect.objectContaining({ 
            error: disconnectError, 
            providerName: 'provider1' 
          }) 
        })
      );
    });

    it('should stop all timers when health monitoring is enabled', async () => {
      const cmWithMonitoring = new ConnectionManager(
        [mockProvider1],
        mockLogger,
        { enabled: true }
      );
      await cmWithMonitoring.onModuleInit();
      
      jest.clearAllMocks();
      
      await cmWithMonitoring.onModuleDestroy();
      
      expect(mockLogger.debug).toHaveBeenCalledWith('Health monitoring stopped');
    });
  });

  describe('connectionOptionsForAllProviders', () => {
    beforeEach(() => {
      connectionManager = new ConnectionManager(
        [mockProvider1, mockProvider2],
        mockLogger,
        { enabled: false }
      );
    });

    it('should return connection options for all providers', () => {
      const options = connectionManager.connectionOptionsForAllProviders();
      
      expect(options).toHaveLength(2);
      expect(options[0]).toEqual({ uniqName: 'provider1' });
      expect(options[1]).toEqual({ uniqName: 'provider2' });
    });
  });

  describe('health monitoring with reconnection', () => {
    let cmWithMonitoring: ConnectionManager;

    beforeEach(async () => {
      cmWithMonitoring = new ConnectionManager(
        [mockProvider1],
        mockLogger,
        { 
          enabled: true,
          healthCheckInterval: { interval: 100, multiplier: 1.2, maxInterval: 1000 },
          reconnectInterval: { interval: 50, multiplier: 2, maxInterval: 500 }
        }
      );
      await cmWithMonitoring.onModuleInit();
      jest.clearAllMocks();
    });

    afterEach(async () => {
      await cmWithMonitoring.onModuleDestroy();
    });

    it('should start WebSocket reconnection when WebSocket health fails', async () => {
      const reconnectSpy = jest.spyOn(mockProvider1, 'reconnectWebSocket').mockResolvedValue();
      
      mockProvider1.setWebSocketHealthy(false);
      
      await mockTimer.triggerCallback();
      
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'WebSocket health check failed, starting WebSocket reconnection',
        expect.objectContaining({
          args: expect.objectContaining({ providerName: 'provider1' }),
          methodName: 'performHealthCheck'
        })
      );
      
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Started websocket reconnection with exponential backoff',
        expect.objectContaining({
          args: expect.objectContaining({ 
            providerName: 'provider1', 
            type: 'websocket'
          })
        })
      );
    });

    it('should start full reconnection when HTTP health fails on single provider', async () => {
      const disconnectSpy = jest.spyOn(mockProvider1, 'disconnect').mockResolvedValue();
      const connectSpy = jest.spyOn(mockProvider1, 'connect').mockResolvedValue();
      
      mockProvider1.setHttpHealthy(false);
      
      await mockTimer.triggerCallback();
      
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'HTTP health check failed for active provider',
        expect.objectContaining({
          args: expect.objectContaining({ providerName: 'provider1' }),
          methodName: 'performHealthCheck'
        })
      );
      
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Only one provider available, attempting to reconnect',
        expect.objectContaining({
          args: expect.objectContaining({ providerName: 'provider1' })
        })
      );
      
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Started full reconnection with exponential backoff',
        expect.objectContaining({
          args: expect.objectContaining({ 
            providerName: 'provider1', 
            type: 'full'
          })
        })
      );
    });

    it('should return true for successful health checks', async () => {
      await mockTimer.triggerCallback();
      
      expect(mockLogger.warn).not.toHaveBeenCalled();
      expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it('should handle race condition in health checks', async () => {
      const firstCheck = mockTimer.triggerCallback();
      const secondCheck = mockTimer.triggerCallback();
      
      await Promise.all([firstCheck, secondCheck]);
      
      expect(mockLogger.debug).toHaveBeenCalledWith('Health check already running, skipping');
    });

    it('should test reconnection attempts with mock timer', async () => {
      // Test WebSocket reconnection attempt
      const reconnectSpy = jest.spyOn(mockProvider1, 'reconnectWebSocket').mockResolvedValue();
      
      // Simulate starting reconnection
      const startReconnection = (cmWithMonitoring as any).startReconnection.bind(cmWithMonitoring);
      startReconnection(mockProvider1, 'websocket');
      
      // Get the new timer created for reconnection
      const reconnectTimer = currentMockTimer;
      
      // Trigger reconnection attempt
      await reconnectTimer.triggerCallback();
      
      expect(reconnectSpy).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        'websocket reconnection successful',
        expect.objectContaining({
          args: expect.objectContaining({ 
            providerName: 'provider1',
            type: 'websocket'
          })
        })
      );
    });

    it('should test full reconnection attempts', async () => {
      const disconnectSpy = jest.spyOn(mockProvider1, 'disconnect').mockResolvedValue();
      const connectSpy = jest.spyOn(mockProvider1, 'connect').mockResolvedValue();
      
      const startReconnection = (cmWithMonitoring as any).startReconnection.bind(cmWithMonitoring);
      startReconnection(mockProvider1, 'full');
      
      const reconnectTimer = currentMockTimer;
      await reconnectTimer.triggerCallback();
      
      expect(disconnectSpy).toHaveBeenCalled();
      expect(connectSpy).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        'full reconnection successful',
        expect.objectContaining({
          args: expect.objectContaining({ 
            providerName: 'provider1',
            type: 'full'
          })
        })
      );
    });
  });
});