import { Test, TestingModule } from '@nestjs/testing';
import { OKMModule, OKMModuleOptions } from '../okm.module';
import { ConnectionManager } from '../connection-manager';
import { EntitiesManager } from '../entities-manager';
import { TransactionsRunner } from '../transactions-runner';
import { EntitySchema } from '../schema';

jest.mock('../connection-manager', () => {
  return {
    ConnectionManager: jest.fn().mockImplementation(() => ({
      database: 'test-db',
      type: 'rocksdb',
      connect: jest.fn().mockResolvedValue(true),
      close: jest.fn().mockResolvedValue(true),
    })),
  };
});

export const OutputSchema = new EntitySchema({
  prefix: 'utxo',
  separator: ':',
  paths: {
    txid_vout: { type: 'dynamic' },
  },
  data: {
    type: 'object',
  },
});

export const BalanceSchema = new EntitySchema({
  prefix: 'balance',
  separator: ':',
  paths: {
    address: { type: 'dynamic' },
    txid_vout: { type: 'dynamic' },
  },
  data: {
    type: 'string',
  },
});

describe('OKMModule', () => {
  let module: TestingModule;
  let connectionManager: ConnectionManager;
  let entitiesManager: EntitiesManager;
  let transactionsRunner: TransactionsRunner;

  // Mock entities for testing
  const mockEntities: EntitySchema[] = [OutputSchema, BalanceSchema];

  // Configuration for the module in tests
  const mockConfig: OKMModuleOptions = {
    database: 'test-db',
    type: 'rocksdb',
    entities: mockEntities,
    options: {},
  };

  beforeEach(async () => {
    // Create a testing module with OKMModule.forRoot
    module = await Test.createTestingModule({
      imports: [OKMModule.forRoot(mockConfig)],
    }).compile();

    // Retrieve instances of the providers from the module
    connectionManager = module.get<ConnectionManager>(ConnectionManager);
    entitiesManager = module.get<EntitiesManager>(EntitiesManager);
    transactionsRunner = module.get<TransactionsRunner>(TransactionsRunner);
  });

  afterEach(async () => {
    // Close the testing module after each test
    await module.close();
  });

  it('should be defined', () => {
    expect(module).toBeDefined();
  });

  describe('EntitiesManager', () => {
    it('should provide EntitiesManager', () => {
      expect(entitiesManager).toBeDefined();
      expect(entitiesManager).toBeInstanceOf(EntitiesManager);
    });
  });

  describe('TransactionsRunner', () => {
    it('should provide TransactionsRunner', () => {
      expect(transactionsRunner).toBeDefined();
      expect(transactionsRunner).toBeInstanceOf(TransactionsRunner);
    });
  });

  describe('Exported Providers', () => {
    it('should export ConnectionManager', () => {
      const exportedConnectionManager = module.get<ConnectionManager>(ConnectionManager);
      expect(exportedConnectionManager).toBeDefined();
      expect(exportedConnectionManager).toBe(connectionManager);
    });

    it('should export EntitiesManager', () => {
      const exportedEntitiesManager = module.get<EntitiesManager>(EntitiesManager);
      expect(exportedEntitiesManager).toBeDefined();
      expect(exportedEntitiesManager).toBe(entitiesManager);
    });

    it('should export TransactionsRunner', () => {
      const exportedTransactionsRunner = module.get<TransactionsRunner>(TransactionsRunner);
      expect(exportedTransactionsRunner).toBeDefined();
      expect(exportedTransactionsRunner).toBe(transactionsRunner);
    });
  });

  describe('Edge Cases', () => {
    it('should handle an empty list of entities correctly', async () => {
      const configWithNoEntities: OKMModuleOptions = {
        database: 'test-db',
        type: 'rocksdb',
        entities: [],
        options: {},
      };

      const testModule = await Test.createTestingModule({
        imports: [OKMModule.forRoot(configWithNoEntities)],
      }).compile();

      const testEntitiesManager = testModule.get<EntitiesManager>(EntitiesManager);
      expect(testEntitiesManager.entities).toEqual(new Map());

      await testModule.close();
    });
  });
});
