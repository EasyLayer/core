import { AbstractBatch } from 'abstract-leveldown';
import { Repository } from '../repository';
import { ConnectionManager } from '../connection-manager';
import { EntitySchema } from '../schema';
import { TransactionsRunner } from '../transactions-runner';

// Specific callback types
type CallbackWithError = (err: any) => void;
type CallbackWithErrorAndData = (err: any, data: any) => void;
type IteratorCallback = (err: any, key?: string, value?: string) => void;
type BatchCallback = (err: any) => void;

class ConnectionManagerMock implements Partial<ConnectionManager> {
  private db: any;

  constructor() {
    this.db = {
      put: jest.fn((key: string, value: string, callback: CallbackWithError) => {
        setImmediate(() => callback(null));
      }),
      get: jest.fn((key: string, callback: CallbackWithErrorAndData) => {
        // Default returns a sample record
        setImmediate(() => callback(null, '{"name":"Test"}'));
      }),
      del: jest.fn((key: string, callback: CallbackWithError) => {
        setImmediate(() => callback(null));
      }),
      iterator: jest.fn(() => ({
        next: jest.fn((cb: IteratorCallback) => {
          // By default, iteration ends immediately
          setImmediate(() => cb(null, undefined, undefined));
        }),
        end: jest.fn((cb: CallbackWithError) => {
          setImmediate(() => cb(null));
        }),
      })),
      batch: jest.fn((operations: AbstractBatch[], callback: BatchCallback) => {
        setImmediate(() => callback(null));
      }),
      close: jest.fn((callback: CallbackWithError) => {
        setImmediate(() => callback(null));
      }),
    };
  }

  getConnection() {
    return this.db;
  }

  closeConnection() {
    return this.db.close();
  }

  onModuleDestroy() {
    return this.closeConnection();
  }
}

class EntitySchemaMock implements Partial<EntitySchema> {
  toFullKeyString = jest.fn();
  toPartialKeyString = jest.fn();
  matchesSuffix = jest.fn();
}

class TransactionsRunnerMock implements Partial<TransactionsRunner> {
  private operations: AbstractBatch[] = [];
  private transactionActive: boolean = false;

  isTransactionActive = jest.fn(() => this.transactionActive);
  addOperation = jest.fn((operation: AbstractBatch) => {
    this.operations.push(operation);
  });
  addOperations = jest.fn((operations: AbstractBatch[]) => {
    operations.forEach((operation) => this.addOperation(operation));
  });

  activateTransaction() {
    this.transactionActive = true;
  }

  deactivateTransaction() {
    this.transactionActive = false;
  }

  getOperations() {
    return this.operations;
  }
}

describe('Repository', () => {
  let connectionManager: ConnectionManagerMock;
  let entitySchema: EntitySchemaMock;
  let transactionsRunner: TransactionsRunnerMock;
  let repository: Repository<any>;
  let db: any;

  beforeEach(() => {
    connectionManager = new ConnectionManagerMock();
    entitySchema = new EntitySchemaMock();
    transactionsRunner = new TransactionsRunnerMock();
    repository = new Repository(
      connectionManager as unknown as ConnectionManager,
      entitySchema as unknown as EntitySchema,
      transactionsRunner as unknown as TransactionsRunner
    );
    db = connectionManager.getConnection();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('put', () => {
    it('should generate full key and call db.put with serialized data', async () => {
      const keyObj = { id: '123' };
      const fullKey = 'order:123:active';
      const data = { name: 'Test' };
      const serializedData = JSON.stringify(data);

      entitySchema.toFullKeyString.mockReturnValue(fullKey);
      jest.spyOn(repository as any, 'serialize').mockReturnValue(serializedData);

      await repository.put(keyObj, data);

      expect(entitySchema.toFullKeyString).toHaveBeenCalledWith(keyObj);
      expect(repository['serialize']).toHaveBeenCalledWith(data);
      expect(db.put).toHaveBeenCalledWith(fullKey, serializedData, expect.any(Function));
    });

    it('should add operation to transaction if active', async () => {
      transactionsRunner.activateTransaction();
      const keyObj = { id: '123' };
      const fullKey = 'order:123:active';
      const data = { name: 'Test' };
      const serializedData = JSON.stringify(data);

      entitySchema.toFullKeyString.mockReturnValue(fullKey);
      jest.spyOn(repository as any, 'serialize').mockReturnValue(serializedData);

      await repository.put(keyObj, data);

      const expectedOperation: AbstractBatch = { type: 'put', key: fullKey, value: serializedData };
      expect(transactionsRunner.addOperation).toHaveBeenCalledWith(expectedOperation);
      expect(db.put).not.toHaveBeenCalled();
    });
  });

  describe('get', () => {
    it('should generate full key and call db.get, then deserialize the data', async () => {
      const keyObj = { id: '123' };
      const fullKey = 'order:123:active';
      const deserializedData = { name: 'Test' };

      entitySchema.toFullKeyString.mockReturnValue(fullKey);
      jest.spyOn(repository as any, 'deserialize').mockReturnValue(deserializedData);

      await expect(repository.get(keyObj)).resolves.toEqual({ key: fullKey, data: deserializedData });
    });

    it('should return null if not found', async () => {
      const keyObj = { id: '123' };
      const fullKey = 'order:123:active';

      entitySchema.toFullKeyString.mockReturnValue(fullKey);
      db.get.mockImplementationOnce((key: string, callback: CallbackWithErrorAndData) => {
        setImmediate(() => callback({ notFound: true }, undefined));
      });

      await expect(repository.get(keyObj)).resolves.toBeNull();
    });

    it('should throw error if db.get returns error other than notFound', async () => {
      const keyObj = { id: '123' };
      const fullKey = 'order:123:active';

      entitySchema.toFullKeyString.mockReturnValue(fullKey);
      db.get.mockImplementationOnce((key: string, callback: CallbackWithErrorAndData) => {
        setImmediate(() => callback(new Error('Some error'), undefined));
      });

      await expect(repository.get(keyObj)).rejects.toThrow('Some error');
    });
  });

  describe('del', () => {
    it('should generate full key and call db.del', async () => {
      const keyObj = { id: '123' };
      const fullKey = 'order:123:active';

      entitySchema.toFullKeyString.mockReturnValue(fullKey);

      await repository.del(keyObj);

      expect(entitySchema.toFullKeyString).toHaveBeenCalledWith(keyObj);
      expect(db.del).toHaveBeenCalledWith(fullKey, expect.any(Function));
    });

    it('should add operation to transaction if active', async () => {
      transactionsRunner.activateTransaction();
      const keyObj = { id: '123' };
      const fullKey = 'order:123:active';

      entitySchema.toFullKeyString.mockReturnValue(fullKey);

      await repository.del(keyObj);

      const expectedOperation: AbstractBatch = { type: 'del', key: fullKey };
      expect(transactionsRunner.addOperation).toHaveBeenCalledWith(expectedOperation);
      expect(db.del).not.toHaveBeenCalled();
    });
  });

  describe('exists', () => {
    it('should return true if data exists', async () => {
      const keyObj = { id: '123' };
      const fullKey = 'order:123:active';

      entitySchema.toFullKeyString.mockReturnValue(fullKey);
      db.get.mockImplementationOnce((key: string, callback: CallbackWithErrorAndData) => {
        setImmediate(() => callback(null, '{"name":"Test"}'));
      });

      const result = await repository.exists(keyObj);
      expect(result).toBe(true);
    });

    it('should return false if data does not exist', async () => {
      const keyObj = { id: '123' };
      const fullKey = 'order:123:active';

      entitySchema.toFullKeyString.mockReturnValue(fullKey);
      db.get.mockImplementationOnce((key: string, callback: CallbackWithErrorAndData) => {
        setImmediate(() => callback({ notFound: true }, undefined));
      });

      const result = await repository.exists(keyObj);
      expect(result).toBe(false);
    });
  });

  describe('getByPartial', () => {
    it('should retrieve data when partial key is provided', async () => {
      const prefix = 'u';
      const partialKey = 'order:u';
      entitySchema.toPartialKeyString.mockReturnValue(partialKey);

      // Two records
      const key1 = 'order:u:1:active';
      const value1 = '{"active":true}'; // valid JSON
      const key2 = 'order:u:2:active';
      const value2 = '{"active":false}'; // valid JSON

      const mockedIterator = {
        next: jest
          .fn()
          .mockImplementationOnce((cb: IteratorCallback) => setImmediate(() => cb(null, key1, value1)))
          .mockImplementationOnce((cb: IteratorCallback) => setImmediate(() => cb(null, key2, value2)))
          .mockImplementationOnce((cb: IteratorCallback) => setImmediate(() => cb(null, undefined, undefined))),
        end: jest.fn((cb: any) => setImmediate(() => cb(null))),
      };

      db.iterator.mockReturnValue(mockedIterator);
      jest.spyOn(repository as any, 'deserialize').mockImplementation((val: any) => JSON.parse(val));

      const results = await repository.getByPartial(prefix);

      expect(results).toEqual([
        { key: key1, data: { active: true } },
        { key: key2, data: { active: false } },
      ]);
    });

    it('should filter by suffix if provided', async () => {
      const prefix = 'u';
      const suffix = 'active';
      const partialKey = 'order:u';
      entitySchema.toPartialKeyString.mockReturnValue(partialKey);

      const key1 = 'order:u:1:active';
      const value1 = '{"name":"Alice"}'; // valid JSON
      const key2 = 'order:u:2:inactive';
      const value2 = '{"name":"Bob"}'; // valid JSON

      // matchesSuffix returns true only if ends with ':active'
      entitySchema.matchesSuffix.mockImplementation((key: string, s: string) => key.endsWith(`:${s}`));

      const mockedIterator = {
        next: jest
          .fn()
          .mockImplementationOnce((cb: IteratorCallback) => setImmediate(() => cb(null, key1, value1)))
          .mockImplementationOnce((cb: IteratorCallback) => setImmediate(() => cb(null, key2, value2)))
          .mockImplementationOnce((cb: IteratorCallback) => setImmediate(() => cb(null, undefined, undefined))),
        end: jest.fn((cb: any) => setImmediate(() => cb(null))),
      };
      db.iterator.mockReturnValue(mockedIterator);
      jest.spyOn(repository as any, 'deserialize').mockImplementation((val: any) => JSON.parse(val));

      const results = await repository.getByPartial(prefix, suffix);

      // Only key1 ends with ':active'
      expect(results).toEqual([{ key: key1, data: { name: 'Alice' } }]);
    });

    it('should handle empty iteration', async () => {
      const prefix = 'none';
      const partialKey = 'order:none';
      entitySchema.toPartialKeyString.mockReturnValue(partialKey);

      // Iterator returns no records
      const mockedIterator = {
        next: jest.fn((cb: IteratorCallback) => setImmediate(() => cb(null, undefined, undefined))),
        end: jest.fn((cb: any) => setImmediate(() => cb(null))),
      };
      db.iterator.mockReturnValue(mockedIterator);

      const results = await repository.getByPartial(prefix);
      expect(results).toEqual([]);
    });
  });

  describe('deleteByPartial', () => {
    it('should filter by suffix if provided and delete only matching', async () => {
      const prefix = 'test';
      const suffix = 'active';
      const partialKey = 'order:test';
      entitySchema.toPartialKeyString.mockReturnValue(partialKey);

      // matchesSuffix: return true only if ends with ':active'
      entitySchema.matchesSuffix.mockImplementation((key: string, s: string) => key.endsWith(`:${s}`));

      const key1 = 'order:test:1:active';
      const key2 = 'order:test:2:inactive';

      const mockedIterator = {
        next: jest
          .fn()
          .mockImplementationOnce((cb: IteratorCallback) => setImmediate(() => cb(null, key1)))
          .mockImplementationOnce((cb: IteratorCallback) => setImmediate(() => cb(null, key2)))
          .mockImplementationOnce((cb: IteratorCallback) => setImmediate(() => cb(null, undefined))),
        end: jest.fn((cb: any) => setImmediate(() => cb(null))),
      };
      db.iterator.mockReturnValue(mockedIterator);
      transactionsRunner.isTransactionActive.mockReturnValue(false);

      await repository.deleteByPartial(prefix, suffix);

      // Only key1 should be deleted
      expect(db.del).toHaveBeenCalledTimes(1);
      expect(db.del).toHaveBeenCalledWith(key1, expect.any(Function));
    });
  });

  describe('countByPartial', () => {
    it('should filter by suffix and count only matching', async () => {
      const prefix = 'count';
      const suffix = 'active';
      const partialKey = 'order:count';
      entitySchema.toPartialKeyString.mockReturnValue(partialKey);

      entitySchema.matchesSuffix.mockImplementation((key: string, s: string) => key.endsWith(`:${s}`));

      const key1 = 'order:count:1:active';
      const key2 = 'order:count:2:inactive';

      const mockedIterator = {
        next: jest
          .fn()
          .mockImplementationOnce((cb: IteratorCallback) => setImmediate(() => cb(null, key1)))
          .mockImplementationOnce((cb: IteratorCallback) => setImmediate(() => cb(null, key2)))
          .mockImplementationOnce((cb: IteratorCallback) => setImmediate(() => cb(null, undefined))),
        end: jest.fn((cb: any) => setImmediate(() => cb(null))),
      };
      db.iterator.mockReturnValue(mockedIterator);

      const cnt = await repository.countByPartial(prefix, suffix);
      // Only key1 matches ':active'
      expect(cnt).toBe(1);
    });
  });
});
