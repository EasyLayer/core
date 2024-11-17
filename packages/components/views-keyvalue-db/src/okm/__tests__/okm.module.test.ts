import { Test, TestingModule } from '@nestjs/testing';
import { OKMModule, OKMModuleConfig } from '../okm.module';
import { ConnectionManager } from '../connection-manager';
import { SchemasManager } from '../schemas-manager';
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
    txid_vout: { type: 'dynamic', required: true },
  },
  values: {
    type: 'object',
  },
});

export const BalanceSchema = new EntitySchema({
  prefix: 'balance',
  separator: ':',
  paths: {
    address: { type: 'dynamic', required: true },
    txid_vout: { type: 'dynamic', required: true },
  },
  values: {
    type: 'string',
  },
});

describe('OKMModule', () => {
  let module: TestingModule;
  let connectionManager: ConnectionManager;
  let schemasManager: SchemasManager;
  let transactionsRunner: TransactionsRunner;

  // Mock schemas for testing
  const mockSchemas: EntitySchema[] = [OutputSchema, BalanceSchema];

  // Configuration for the module in tests
  const mockConfig: OKMModuleConfig = {
    database: 'test-db',
    type: 'rocksdb',
    schemas: mockSchemas,
  };

  beforeEach(async () => {
    // Create a testing module with OKMModule.forRoot
    module = await Test.createTestingModule({
      imports: [OKMModule.forRoot(mockConfig)],
    }).compile();

    // Retrieve instances of the providers from the module
    connectionManager = module.get<ConnectionManager>(ConnectionManager);
    schemasManager = module.get<SchemasManager>(SchemasManager);
    transactionsRunner = module.get<TransactionsRunner>(TransactionsRunner);
  });

  afterEach(async () => {
    // Close the testing module after each test
    await module.close();
  });

  it('should be defined', () => {
    expect(module).toBeDefined();
  });

  describe('SchemasManager', () => {
    it('should provide SchemasManager', () => {
      expect(schemasManager).toBeDefined();
      expect(schemasManager).toBeInstanceOf(SchemasManager);
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

    it('should export SchemasManager', () => {
      const exportedSchemasManager = module.get<SchemasManager>(SchemasManager);
      expect(exportedSchemasManager).toBeDefined();
      expect(exportedSchemasManager).toBe(schemasManager);
    });

    it('should export TransactionsRunner', () => {
      const exportedTransactionsRunner = module.get<TransactionsRunner>(TransactionsRunner);
      expect(exportedTransactionsRunner).toBeDefined();
      expect(exportedTransactionsRunner).toBe(transactionsRunner);
    });
  });

  describe('Edge Cases', () => {
    it('should handle an empty list of schemas correctly', async () => {
      const configWithNoSchemas: OKMModuleConfig = {
        database: 'test-db',
        type: 'rocksdb',
        schemas: [],
      };

      const testModule = await Test.createTestingModule({
        imports: [OKMModule.forRoot(configWithNoSchemas)],
      }).compile();

      const testSchemasManager = testModule.get<SchemasManager>(SchemasManager);
      expect(testSchemasManager.schemas).toEqual(new Map());

      await testModule.close();
    });
  });
});