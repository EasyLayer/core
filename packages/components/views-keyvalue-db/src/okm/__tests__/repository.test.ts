import { AbstractBatch } from 'abstract-leveldown';
import { Repository } from '../repository';
import { ConnectionManager } from '../connection-manager';
import { EntitySchema } from '../schema';
import { TransactionsRunner } from '../transactions-runner';

// Define specific callback types
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
        setImmediate(() => callback(null, '{"name":"Test"}'));
      }),
      del: jest.fn((key: string, callback: CallbackWithError) => {
        setImmediate(() => callback(null));
      }),
      iterator: jest.fn(() => ({
        next: jest.fn((cb: IteratorCallback) => {
          // By default, iteration is complete
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
  generateKey = jest.fn();
  generatePrefix = jest.fn();
  parseKey = jest.fn();
  generatePrefixFromString = jest.fn();
  matchesSuffix = jest.fn();
}

class TransactionsRunnerMock implements Partial<TransactionsRunner> {
  private operations: AbstractBatch[] = [];
  private transactionActive: boolean = false;

  isTransactionActive = jest.fn(() => this.transactionActive);
  addOperation = jest.fn((operation: AbstractBatch) => {
    this.operations.push(operation);
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
    it('should generate key and call db.put with serialized data', async () => {
      const paths = { id: '123' };
      const data = { name: 'Test' };
      const generatedKey = '123';
      const serializedData = JSON.stringify(data);

      entitySchema.generateKey.mockReturnValue(generatedKey);
      jest.spyOn(repository as any, 'serialize').mockReturnValue(serializedData);

      await repository.put(paths, data);

      expect(entitySchema.generateKey).toHaveBeenCalledWith(paths);
      expect(repository['serialize']).toHaveBeenCalledWith(data);
      expect(db.put).toHaveBeenCalledWith(
        generatedKey,
        serializedData,
        expect.any(Function) as unknown as CallbackWithError
      );
    });

    it('should add operation to transaction if active', async () => {
      transactionsRunner.activateTransaction();
      const paths = { id: '123' };
      const data = { name: 'Test' };
      const generatedKey = '123';
      const serializedData = JSON.stringify(data);

      entitySchema.generateKey.mockReturnValue(generatedKey);
      jest.spyOn(repository as any, 'serialize').mockReturnValue(serializedData);

      await repository.put(paths, data);

      const expectedOperation: AbstractBatch = { type: 'put', key: generatedKey, value: serializedData };
      expect(transactionsRunner.addOperation).toHaveBeenCalledWith(expectedOperation);
      expect(db.put).not.toHaveBeenCalled();
    });
  });

  describe('get', () => {
    it('should generate key and call db.get, then deserialize the data', async () => {
      const paths = { id: '123' };
      const generatedKey = '123';
      const serializedData = '{"name":"Test"}';
      const deserializedData = { name: 'Test' };
      const parsedKey = { id: '123' };

      entitySchema.generateKey.mockReturnValue(generatedKey);
      entitySchema.parseKey.mockReturnValue(parsedKey);
      jest.spyOn(repository as any, 'deserialize').mockReturnValue(deserializedData);

      await expect(repository.get(paths)).resolves.toEqual({ key: parsedKey, data: deserializedData });

      expect(entitySchema.generateKey).toHaveBeenCalledWith(paths);
      expect(db.get).toHaveBeenCalledWith(generatedKey, expect.any(Function) as unknown as CallbackWithErrorAndData);
      expect(repository['deserialize']).toHaveBeenCalledWith(serializedData);
      expect(entitySchema.parseKey).toHaveBeenCalledWith(generatedKey);
    });

    it('should return null if not found', async () => {
      const paths = { id: '123' };
      const generatedKey = '123';

      entitySchema.generateKey.mockReturnValue(generatedKey);
      db.get.mockImplementationOnce((key: string, callback: CallbackWithErrorAndData) => {
        setImmediate(() => callback({ notFound: true }, undefined));
      });

      await expect(repository.get(paths)).resolves.toBeNull();

      expect(entitySchema.generateKey).toHaveBeenCalledWith(paths);
      expect(db.get).toHaveBeenCalledWith(generatedKey, expect.any(Function) as unknown as CallbackWithErrorAndData);
    });

    it('should throw error if db.get returns error other than notFound', async () => {
      const paths = { id: '123' };
      const generatedKey = '123';

      entitySchema.generateKey.mockReturnValue(generatedKey);
      db.get.mockImplementationOnce((key: string, callback: CallbackWithErrorAndData) => {
        setImmediate(() => callback(new Error('Some error'), undefined));
      });

      await expect(repository.get(paths)).rejects.toThrow('Some error');

      expect(entitySchema.generateKey).toHaveBeenCalledWith(paths);
      expect(db.get).toHaveBeenCalledWith(generatedKey, expect.any(Function) as unknown as CallbackWithErrorAndData);
    });
  });

  describe('del', () => {
    it('should generate key and call db.del', async () => {
      const paths = { id: '123' };
      const generatedKey = '123';

      entitySchema.generateKey.mockReturnValue(generatedKey);

      await repository.del(paths);

      expect(entitySchema.generateKey).toHaveBeenCalledWith(paths);
      expect(db.del).toHaveBeenCalledWith(generatedKey, expect.any(Function) as unknown as CallbackWithError);
    });

    it('should add operation to transaction if active', async () => {
      transactionsRunner.activateTransaction();
      const paths = { id: '123' };
      const generatedKey = '123';

      entitySchema.generateKey.mockReturnValue(generatedKey);

      await repository.del(paths);

      const expectedOperation: AbstractBatch = { type: 'del', key: generatedKey };
      expect(transactionsRunner.addOperation).toHaveBeenCalledWith(expectedOperation);
      expect(db.del).not.toHaveBeenCalled();
    });
  });

  describe('exists', () => {
    it('should return true if data exists', async () => {
      const paths = { id: '123' };
      const generatedKey = '123';
      const parsedKey = { id: '123' };

      entitySchema.generateKey.mockReturnValue(generatedKey);
      entitySchema.parseKey.mockReturnValue(parsedKey);
      db.get.mockImplementationOnce((key: string, callback: CallbackWithErrorAndData) => {
        setImmediate(() => callback(null, '{"name":"Test"}'));
      });

      const result = await repository.exists(paths);

      expect(entitySchema.generateKey).toHaveBeenCalledWith(paths);
      expect(db.get).toHaveBeenCalledWith(generatedKey, expect.any(Function) as unknown as CallbackWithErrorAndData);
      expect(result).toBe(true);
    });

    it('should return false if data does not exist', async () => {
      const paths = { id: '123' };
      const generatedKey = '123';

      entitySchema.generateKey.mockReturnValue(generatedKey);
      db.get.mockImplementationOnce((key: string, callback: CallbackWithErrorAndData) => {
        setImmediate(() => callback({ notFound: true }, undefined));
      });

      const result = await repository.exists(paths);

      expect(entitySchema.generateKey).toHaveBeenCalledWith(paths);
      expect(db.get).toHaveBeenCalledWith(generatedKey, expect.any(Function) as unknown as CallbackWithErrorAndData);
      expect(result).toBe(false);
    });
  });

  describe('getByPartial', () => {
    it('should retrieve data when only prefix is provided', async () => {
      const prefix = 'user';
      const generatedPrefix = 'prefix:user';
      const key1 = 'prefix:user:1';
      const value1 = '{"active":true}';
      const key2 = 'prefix:user:2';
      const value2 = '{"active":false}';
      const parsedKey1 = { id: '1' };
      const parsedKey2 = { id: '2' };

      entitySchema.generatePrefixFromString.mockReturnValue(generatedPrefix);
      entitySchema.parseKey.mockImplementationOnce(() => parsedKey1).mockImplementationOnce(() => parsedKey2);

      const mockedIterator = {
        next: jest
          .fn()
          .mockImplementationOnce((cb: any) => setImmediate(() => cb(null, key1, value1)))
          .mockImplementationOnce((cb: any) => setImmediate(() => cb(null, key2, value2)))
          .mockImplementationOnce((cb: any) => setImmediate(() => cb(null, undefined, undefined))),
        end: jest.fn((cb: any) => setImmediate(() => cb(null))),
      };

      db.iterator.mockReturnValue(mockedIterator);
      jest.spyOn(repository as any, 'deserialize').mockImplementation((value: any) => JSON.parse(value));

      const result = await repository.getByPartial(prefix);

      expect(entitySchema.generatePrefixFromString).toHaveBeenCalledWith(prefix);
      expect(db.iterator).toHaveBeenCalledWith({
        gte: generatedPrefix,
        lte: `${generatedPrefix}\xFF`,
        keyAsBuffer: false,
        valueAsBuffer: false,
      });

      expect(mockedIterator.next).toHaveBeenCalledTimes(3);
      expect(mockedIterator.end).toHaveBeenCalled();
      expect(repository['deserialize']).toHaveBeenCalledWith(value1);
      expect(repository['deserialize']).toHaveBeenCalledWith(value2);

      expect(entitySchema.parseKey).toHaveBeenCalledWith(key1);
      expect(entitySchema.parseKey).toHaveBeenCalledWith(key2);

      expect(result).toEqual([
        { key: parsedKey1, data: { active: true } },
        { key: parsedKey2, data: { active: false } },
      ]);
    });

    it('should retrieve data when both prefix and suffix are provided', async () => {
      const prefix = 'user';
      const suffix = 'active';
      const generatedPrefix = 'prefix:user';
      const key1 = 'prefix:user:1:active';
      const value1 = '{"name":"Alice"}';
      const key2 = 'prefix:user:2:inactive';
      const value2 = '{"name":"Bob"}';
      const parsedKey1 = { id: '1', status: 'active' };

      entitySchema.generatePrefixFromString.mockReturnValue(generatedPrefix);
      entitySchema.matchesSuffix.mockImplementation((key: string, suff: string) => {
        const separator = ':';
        return key.endsWith(separator + suff);
      });
      entitySchema.parseKey.mockReturnValue(parsedKey1);

      const mockedIterator = {
        next: jest
          .fn()
          .mockImplementationOnce((cb: any) => setImmediate(() => cb(null, key1, value1)))
          .mockImplementationOnce((cb: any) => setImmediate(() => cb(null, key2, value2)))
          .mockImplementationOnce((cb: any) => setImmediate(() => cb(null, undefined, undefined))),
        end: jest.fn((cb: any) => setImmediate(() => cb(null))),
      };

      db.iterator.mockReturnValue(mockedIterator);
      jest.spyOn(repository as any, 'deserialize').mockImplementation((value: any) => JSON.parse(value));

      const result = await repository.getByPartial(prefix, suffix);

      expect(entitySchema.generatePrefixFromString).toHaveBeenCalledWith(prefix);
      expect(db.iterator).toHaveBeenCalledWith({
        gte: generatedPrefix,
        lte: `${generatedPrefix}\xFF`,
        keyAsBuffer: false,
        valueAsBuffer: false,
      });

      expect(mockedIterator.next).toHaveBeenCalledTimes(3);
      expect(mockedIterator.end).toHaveBeenCalled();

      expect(entitySchema.matchesSuffix).toHaveBeenCalledWith(key1, suffix);
      expect(entitySchema.matchesSuffix).toHaveBeenCalledWith(key2, suffix);

      expect(repository['deserialize']).toHaveBeenCalledWith(value1);
      expect(repository['deserialize']).toHaveBeenCalledTimes(1);

      expect(entitySchema.parseKey).toHaveBeenCalledWith(key1);

      expect(result).toEqual([{ key: parsedKey1, data: { name: 'Alice' } }]);
    });

    it('should handle errors and close iterator', async () => {
      const prefix = 'user';
      const generatedPrefix = 'prefix:user';

      entitySchema.generatePrefixFromString.mockReturnValue(generatedPrefix);

      const mockedIterator = {
        next: jest.fn((cb: any) => setImmediate(() => cb(new Error('Iterator error'), undefined, undefined))),
        end: jest.fn((cb: any) => setImmediate(() => cb(null))),
      };

      db.iterator.mockReturnValue(mockedIterator);

      await expect(repository.getByPartial(prefix)).rejects.toThrow('Iterator error');

      expect(mockedIterator.end).toHaveBeenCalled();
    });
  });

  describe('deleteByPartial', () => {
    it('should delete records when only prefix is provided', async () => {
      const prefix = 'user';
      const generatedPrefix = 'prefix:user';
      const key1 = 'prefix:user:1';
      const key2 = 'prefix:user:2';

      entitySchema.generatePrefixFromString.mockReturnValue(generatedPrefix);

      const mockedIterator = {
        next: jest
          .fn()
          .mockImplementationOnce((cb: any) => setImmediate(() => cb(null, key1)))
          .mockImplementationOnce((cb: any) => setImmediate(() => cb(null, key2)))
          .mockImplementationOnce((cb: any) => setImmediate(() => cb(null, undefined))),
        end: jest.fn((cb: any) => setImmediate(() => cb(null))),
      };

      db.iterator.mockReturnValue(mockedIterator);
      transactionsRunner.isTransactionActive.mockReturnValue(false);

      await repository.deleteByPartial(prefix);

      expect(entitySchema.generatePrefixFromString).toHaveBeenCalledWith(prefix);
      expect(db.iterator).toHaveBeenCalledWith({
        gte: generatedPrefix,
        lte: `${generatedPrefix}\xFF`,
        keyAsBuffer: false,
        valueAsBuffer: false,
      });

      expect(db.del).toHaveBeenCalledTimes(2);
      expect(db.del).toHaveBeenNthCalledWith(1, key1, expect.any(Function));
      expect(db.del).toHaveBeenNthCalledWith(2, key2, expect.any(Function));
      expect(mockedIterator.end).toHaveBeenCalled();
    });

    it('should delete records when both prefix and suffix are provided', async () => {
      const prefix = 'user';
      const suffix = 'active';
      const generatedPrefix = 'prefix:user';
      const key1 = 'prefix:user:1:active';
      const key2 = 'prefix:user:2:inactive';

      entitySchema.generatePrefixFromString.mockReturnValue(generatedPrefix);
      entitySchema.matchesSuffix.mockImplementation((key: string, suff: string) => {
        const separator = ':';
        return key.endsWith(separator + suff);
      });

      const mockedIterator = {
        next: jest
          .fn()
          .mockImplementationOnce((cb: any) => setImmediate(() => cb(null, key1)))
          .mockImplementationOnce((cb: any) => setImmediate(() => cb(null, key2)))
          .mockImplementationOnce((cb: any) => setImmediate(() => cb(null, undefined))),
        end: jest.fn((cb: any) => setImmediate(() => cb(null))),
      };

      db.iterator.mockReturnValue(mockedIterator);
      transactionsRunner.isTransactionActive.mockReturnValue(false);

      await repository.deleteByPartial(prefix, suffix);

      expect(db.del).toHaveBeenCalledTimes(1);
      expect(db.del).toHaveBeenCalledWith(key1, expect.any(Function));
      expect(mockedIterator.end).toHaveBeenCalled();
    });

    it('should add delete operations to transaction if active', async () => {
      const prefix = 'user';
      const suffix = 'active';
      const generatedPrefix = 'prefix:user';
      const key1 = 'prefix:user:1:active';
      const key2 = 'prefix:user:2:inactive';

      entitySchema.generatePrefixFromString.mockReturnValue(generatedPrefix);
      entitySchema.matchesSuffix.mockImplementation((key: string, suff: string) => {
        const separator = ':';
        return key.endsWith(separator + suff);
      });
      transactionsRunner.isTransactionActive.mockReturnValue(true);

      const mockedIterator = {
        next: jest
          .fn()
          .mockImplementationOnce((cb: any) => setImmediate(() => cb(null, key1)))
          .mockImplementationOnce((cb: any) => setImmediate(() => cb(null, key2)))
          .mockImplementationOnce((cb: any) => setImmediate(() => cb(null, undefined))),
        end: jest.fn((cb: any) => setImmediate(() => cb(null))),
      };

      db.iterator.mockReturnValue(mockedIterator);

      await repository.deleteByPartial(prefix, suffix);

      const expectedOperation: AbstractBatch = { type: 'del', key: key1 };

      expect(transactionsRunner.addOperation).toHaveBeenCalledWith(expectedOperation);
      expect(db.del).not.toHaveBeenCalled();
      expect(mockedIterator.end).toHaveBeenCalled();
    });

    it('should handle errors and close iterator', async () => {
      const prefix = 'user';
      const generatedPrefix = 'prefix:user';

      entitySchema.generatePrefixFromString.mockReturnValue(generatedPrefix);

      const mockedIterator = {
        next: jest.fn((cb: any) => setImmediate(() => cb(new Error('Iterator error'), undefined))),
        end: jest.fn((cb: any) => setImmediate(() => cb(null))),
      };

      db.iterator.mockReturnValue(mockedIterator);

      await expect(repository.deleteByPartial(prefix)).rejects.toThrow('Iterator error');

      expect(mockedIterator.end).toHaveBeenCalled();
    });
  });

  describe('countByPartial', () => {
    it('should count records when only prefix is provided', async () => {
      const prefix = 'user';
      const generatedPrefix = 'prefix:user';
      const key1 = 'prefix:user:1';
      const key2 = 'prefix:user:2';

      entitySchema.generatePrefixFromString.mockReturnValue(generatedPrefix);

      const mockedIterator = {
        next: jest
          .fn()
          .mockImplementationOnce((cb: any) => setImmediate(() => cb(null, key1)))
          .mockImplementationOnce((cb: any) => setImmediate(() => cb(null, key2)))
          .mockImplementationOnce((cb: any) => setImmediate(() => cb(null, undefined))),
        end: jest.fn((cb: any) => setImmediate(() => cb(null))),
      };

      db.iterator.mockReturnValue(mockedIterator);

      const count = await repository.countByPartial(prefix);

      expect(entitySchema.generatePrefixFromString).toHaveBeenCalledWith(prefix);
      expect(db.iterator).toHaveBeenCalledWith({
        gte: generatedPrefix,
        lte: `${generatedPrefix}\xFF`,
        keyAsBuffer: false,
        valueAsBuffer: false,
      });

      expect(count).toBe(2);
      expect(mockedIterator.end).toHaveBeenCalled();
    });

    it('should count records when both prefix and suffix are provided', async () => {
      const prefix = 'user';
      const suffix = 'active';
      const generatedPrefix = 'prefix:user';
      const key1 = 'prefix:user:1:active';
      const key2 = 'prefix:user:2:inactive';

      entitySchema.generatePrefixFromString.mockReturnValue(generatedPrefix);
      entitySchema.matchesSuffix.mockImplementation((key: string, suff: string) => {
        const separator = ':';
        return key.endsWith(separator + suff);
      });

      const mockedIterator = {
        next: jest
          .fn()
          .mockImplementationOnce((cb: any) => setImmediate(() => cb(null, key1)))
          .mockImplementationOnce((cb: any) => setImmediate(() => cb(null, key2)))
          .mockImplementationOnce((cb: any) => setImmediate(() => cb(null, undefined))),
        end: jest.fn((cb: any) => setImmediate(() => cb(null))),
      };

      db.iterator.mockReturnValue(mockedIterator);

      const count = await repository.countByPartial(prefix, suffix);

      expect(count).toBe(1);
      expect(mockedIterator.end).toHaveBeenCalled();
    });

    it('should handle errors and close iterator', async () => {
      const prefix = 'user';
      const generatedPrefix = 'prefix:user';

      entitySchema.generatePrefixFromString.mockReturnValue(generatedPrefix);

      const mockedIterator = {
        next: jest.fn((cb: any) => setImmediate(() => cb(new Error('Iterator error'), undefined))),
        end: jest.fn((cb: any) => setImmediate(() => cb(null))),
      };

      db.iterator.mockReturnValue(mockedIterator);

      await expect(repository.countByPartial(prefix)).rejects.toThrow('Iterator error');

      expect(mockedIterator.end).toHaveBeenCalled();
    });
  });
});
