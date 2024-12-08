import { AbstractBatch } from 'abstract-leveldown';
import { Repository, DataFactory } from '../repository';
import { ConnectionManager } from '../connection-manager';
import { EntitySchema } from '../schema';
import { TransactionsRunner } from '../transactions-runner';

// Type guard to check if the operation is a 'put' type
function isPutBatch(op: AbstractBatch): op is { type: 'put'; key: string; value: string } {
  return op.type === 'put';
}

// Mock for ConnectionManager
class ConnectionManagerMock implements Partial<ConnectionManager> {
  private db: any;
  constructor() {
    this.db = {};
  }
  getConnection() {
    return this.db;
  }
  async closeConnection() {}
  async onModuleDestroy() {}
}

// Mock for EntitySchema
class EntitySchemaMock implements Partial<EntitySchema> {
  toFullKeyString = jest.fn();
  toPartialKeyString = jest.fn();
  matchesSuffix = jest.fn();
  validateData = jest.fn();
}

// Mock for TransactionsRunner
class TransactionsRunnerMock implements Partial<TransactionsRunner> {
  private operations: AbstractBatch[] = [];
  private transactionActive: boolean = false;

  isTransactionActive = jest.fn(() => this.transactionActive);
  addOperation = jest.fn((operation: AbstractBatch) => {
    this.operations.push(operation);
  });
  addOperations = jest.fn((operations: AbstractBatch[]) => {
    operations.forEach((op) => this.addOperation(op));
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

describe('Repository update methods', () => {
  let connectionManager: ConnectionManagerMock;
  let entitySchema: EntitySchemaMock;
  let transactionsRunner: TransactionsRunnerMock;
  let repository: Repository<any>;

  beforeEach(() => {
    connectionManager = new ConnectionManagerMock();
    entitySchema = new EntitySchemaMock();
    transactionsRunner = new TransactionsRunnerMock();
    repository = new Repository(
      connectionManager as unknown as ConnectionManager,
      entitySchema as unknown as EntitySchema,
      transactionsRunner as unknown as TransactionsRunner
    );

    // Mock serialization/deserialization methods
    jest.spyOn(repository as any, 'serialize').mockImplementation((val: any) => JSON.stringify(val));
    jest.spyOn(repository as any, 'deserialize').mockImplementation((val: any) => JSON.parse(val));

    // Mock internal methods that are not the focus of these tests
    (repository as any).resolvePaths = jest.fn();
    (repository as any).generatePathCombinations = jest.fn();
    (repository as any).get = jest.fn();
    (repository as any).schema = entitySchema as unknown as EntitySchema;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('update', () => {
    it('should throw an error if no active transaction', async () => {
      await expect(
        repository.update({ id: '1' }, { pathToUpdate: { status: 'active' }, dataToUpdate: { name: 'John' } })
      ).rejects.toThrow('update must be called within an active transaction');
    });

    it('should update paths and data correctly', async () => {
      transactionsRunner.activateTransaction();

      // Mock resolved paths and combinations
      (repository as any).resolvePaths.mockResolvedValue({ id: '1' });
      (repository as any).generatePathCombinations.mockReturnValue([{ id: '1' }]);

      // Mock get method to return existing record
      (repository as any).get.mockResolvedValue({ key: 'fullKey1', data: { name: 'John', age: 25 } });

      // Mock schema methods
      entitySchema.toFullKeyString
        .mockReturnValueOnce('fullKey1') // oldValidKey
        .mockReturnValueOnce('fullKey2'); // newValidKey

      await repository.update(
        { id: '1' },
        {
          pathToUpdate: { status: 'active' },
          dataToUpdate: { age: 26 },
        }
      );

      const ops = transactionsRunner.getOperations();
      expect(ops).toHaveLength(2);

      // Check delete operation
      expect(ops[0]).toEqual({ type: 'del', key: 'fullKey1' });

      // Check put operation with updated data
      if (isPutBatch(ops[1])) {
        expect(ops[1].key).toBe('fullKey2');
        expect(JSON.parse(ops[1].value)).toEqual({ name: 'John', age: 26 });
      }
    });

    it('should replace data if existing data is not an object', async () => {
      transactionsRunner.activateTransaction();

      (repository as any).resolvePaths.mockResolvedValue({ id: '2' });
      (repository as any).generatePathCombinations.mockReturnValue([{ id: '2' }]);
      (repository as any).get.mockResolvedValue({ key: 'fullKey2', data: 'nonObjectData' });

      entitySchema.toFullKeyString
        .mockReturnValueOnce('fullKey2') // oldValidKey
        .mockReturnValueOnce('fullKey3'); // newValidKey

      await repository.update(
        { id: '2' },
        {
          pathToUpdate: { status: 'inactive' },
          dataToUpdate: { status: 'inactive' },
        }
      );

      const ops = transactionsRunner.getOperations();
      expect(ops).toHaveLength(2);

      expect(ops[0]).toEqual({ type: 'del', key: 'fullKey2' });

      if (isPutBatch(ops[1])) {
        expect(ops[1].key).toBe('fullKey3');
        expect(JSON.parse(ops[1].value)).toEqual({ status: 'inactive' });
      }
    });

    it('should handle dataToUpdate as full data object', async () => {
      transactionsRunner.activateTransaction();

      (repository as any).resolvePaths.mockResolvedValue({ id: '3' });
      (repository as any).generatePathCombinations.mockReturnValue([{ id: '3' }]);
      (repository as any).get.mockResolvedValue({ key: 'fullKey3', data: { name: 'Alice' } });

      entitySchema.toFullKeyString
        .mockReturnValueOnce('fullKey3') // oldValidKey
        .mockReturnValueOnce('fullKey4'); // newValidKey

      await repository.update(
        { id: '3' },
        {
          pathToUpdate: { role: 'admin' },
          dataToUpdate: { name: 'Alice', role: 'admin' },
        }
      );

      const ops = transactionsRunner.getOperations();
      expect(ops).toHaveLength(2);

      expect(ops[0]).toEqual({ type: 'del', key: 'fullKey3' });

      if (isPutBatch(ops[1])) {
        expect(ops[1].key).toBe('fullKey4');
        expect(JSON.parse(ops[1].value)).toEqual({ name: 'Alice', role: 'admin' });
      }
    });

    it('should handle dataToUpdate as null', async () => {
      transactionsRunner.activateTransaction();

      (repository as any).resolvePaths.mockResolvedValue({ id: '4' });
      (repository as any).generatePathCombinations.mockReturnValue([{ id: '4' }]);
      (repository as any).get.mockResolvedValue({
        key: 'fullKey4',
        data: { email: 'user4@example.com', name: 'User Four' },
      });

      entitySchema.toFullKeyString
        .mockReturnValueOnce('fullKey4') // oldValidKey
        .mockReturnValueOnce('fullKey5'); // newValidKey

      await repository.update(
        { id: '4' },
        {
          pathToUpdate: { status: 'active' },
          dataToUpdate: null,
        }
      );

      const ops = transactionsRunner.getOperations();
      expect(ops).toHaveLength(2);

      expect(ops[0]).toEqual({ type: 'del', key: 'fullKey4' });

      if (isPutBatch(ops[1])) {
        expect(ops[1].key).toBe('fullKey5');
        expect(JSON.parse(ops[1].value)).toBeNull(); // Expecting null
      }
    });
  });

  describe('updateByPartial', () => {
    it('should throw an error if no active transaction', async () => {
      await expect(
        repository.updateByPartial(
          { role: 'member' },
          {
            pathToUpdate: { role: 'admin' },
            dataToUpdate: { email: 'admin@example.com' },
          }
        )
      ).rejects.toThrow('updateByPartial must be called within an active transaction');
    });

    it('should update paths correctly without altering data when dataToUpdate is not provided', async () => {
      transactionsRunner.activateTransaction();

      // Mock resolved paths and combinations
      (repository as any).resolvePaths.mockResolvedValue({ role: 'member', id: '1' });
      (repository as any).generatePathCombinations.mockReturnValue([{ role: 'member', id: '1' }]);

      // Mock get method to return existing record
      (repository as any).get.mockResolvedValue({
        key: 'fullKey1',
        data: { email: 'user1@example.com', name: 'User One' },
      });

      // Mock schema methods
      entitySchema.toFullKeyString
        .mockReturnValueOnce('fullKey1') // oldValidKey
        .mockReturnValueOnce('fullKey2'); // newValidKey

      await repository.updateByPartial(
        { role: 'member', id: '1' },
        {
          pathToUpdate: { role: 'admin' },
          // dataToUpdate is not provided
        }
      );

      const ops = transactionsRunner.getOperations();
      expect(ops).toHaveLength(2);

      expect(ops[0]).toEqual({ type: 'del', key: 'fullKey1' });

      if (isPutBatch(ops[1])) {
        expect(ops[1].key).toBe('fullKey2');
        expect(JSON.parse(ops[1].value)).toEqual({ email: 'user1@example.com', name: 'User One' });
      }
    });

    it('should update paths and data correctly with dataToUpdate as object', async () => {
      transactionsRunner.activateTransaction();

      // Mock resolved paths and combinations
      (repository as any).resolvePaths.mockResolvedValue({ role: 'member', id: '1' });
      (repository as any).generatePathCombinations.mockReturnValue([{ role: 'member', id: '1' }]);

      // Mock get method to return existing record
      (repository as any).get.mockResolvedValue({
        key: 'fullKey1',
        data: { email: 'user1@example.com', name: 'User One' },
      });

      // Mock schema methods
      entitySchema.toFullKeyString
        .mockReturnValueOnce('fullKey1') // oldValidKey
        .mockReturnValueOnce('fullKey2'); // newValidKey

      await repository.updateByPartial(
        { role: 'member', id: '1' },
        {
          pathToUpdate: { role: 'admin' },
          dataToUpdate: { email: 'admin1@example.com' },
        }
      );

      const ops = transactionsRunner.getOperations();
      expect(ops).toHaveLength(2);

      expect(ops[0]).toEqual({ type: 'del', key: 'fullKey1' });

      if (isPutBatch(ops[1])) {
        expect(ops[1].key).toBe('fullKey2');
        expect(JSON.parse(ops[1].value)).toEqual({ email: 'admin1@example.com', name: 'User One' });
      }
    });

    it('should update data using DataFactory function with conditional logic', async () => {
      transactionsRunner.activateTransaction();

      // Mock for paths
      (repository as any).resolvePaths.mockResolvedValue({ role: 'member', id: ['2', '3'] });
      (repository as any).generatePathCombinations.mockReturnValue([
        { role: 'member', id: '2' },
        { role: 'member', id: '3' },
      ]);

      // Mock get for different records
      (repository as any).get.mockImplementation((combination: any) => {
        if (combination.id === '2') {
          return Promise.resolve({ key: 'fullKey2', data: { email: 'user2@example.com', name: 'User Two' } });
        } else if (combination.id === '3') {
          return Promise.resolve({ key: 'fullKey3', data: { email: 'user3@example.com', name: 'User Three' } });
        }
        return Promise.resolve(null);
      });

      // Mock schema methods
      entitySchema.toFullKeyString
        .mockReturnValueOnce('fullKey2') // oldValidKey for id '2'
        .mockReturnValueOnce('fullKey4') // newValidKey for id '2'
        .mockReturnValueOnce('fullKey3') // oldValidKey for id '3'
        .mockReturnValueOnce('fullKey5'); // newValidKey for id '3'

      // Directly mock serialize method
      (repository as any).serialize = jest.fn((val: any) => {
        const serialized = JSON.stringify(val);
        console.log('Serialize called with:', val, '->', serialized);
        return serialized;
      });

      // DataFactory with conditional logic
      const dataFactory: DataFactory<any> = (currentData) => {
        if (!currentData) {
          throw new Error('No data to update');
        }
        // For 'user2@example.com' we update the email
        if (currentData.email === 'user2@example.com') {
          return { email: `updated_${currentData.email}` };
        }
        // For 'user3@example.com' we update the name
        if (currentData.email === 'user3@example.com') {
          return { name: 'Updated User Three' };
        }
        // If none of the above, return empty object
        return {};
      };

      await repository.updateByPartial(
        { role: 'member', id: ['2', '3'] },
        {
          pathToUpdate: { role: 'admin' },
          dataToUpdate: dataFactory,
        }
      );

      const ops = transactionsRunner.getOperations();
      console.log('Batch Operations:', ops);

      expect(ops).toHaveLength(4);

      // For id '2'
      expect(ops[0]).toEqual({ type: 'del', key: 'fullKey2' });
      if (isPutBatch(ops[1])) {
        expect(ops[1].key).toBe('fullKey4');
        // After dataFactory, user2 data should have updated email but same name
        // Just email updated, no 'role' in data
        expect(JSON.parse(ops[1].value)).toEqual({ email: 'updated_user2@example.com', name: 'User Two' });
      }

      // For id '3'
      expect(ops[2]).toEqual({ type: 'del', key: 'fullKey3' });
      if (isPutBatch(ops[3])) {
        expect(ops[3].key).toBe('fullKey5');
        // After dataFactory, user3 data should have updated name but same email
        expect(JSON.parse(ops[3].value)).toEqual({ email: 'user3@example.com', name: 'Updated User Three' });
      }
    });

    it('should handle dataToUpdate as a complete data object', async () => {
      transactionsRunner.activateTransaction();

      (repository as any).resolvePaths.mockResolvedValue({ role: 'guest', id: '3' });
      (repository as any).generatePathCombinations.mockReturnValue([{ role: 'guest', id: '3' }]);
      (repository as any).get.mockResolvedValue({ key: 'fullKey3', data: { email: 'user3@example.com' } });

      entitySchema.toFullKeyString
        .mockReturnValueOnce('fullKey3') // oldValidKey
        .mockReturnValueOnce('fullKey4'); // newValidKey

      await repository.updateByPartial(
        { role: 'guest', id: '3' },
        {
          pathToUpdate: { role: 'member' },
          dataToUpdate: { email: 'member3@example.com', name: 'Member Three' },
        }
      );

      const ops = transactionsRunner.getOperations();
      expect(ops).toHaveLength(2);

      expect(ops[0]).toEqual({ type: 'del', key: 'fullKey3' });

      if (isPutBatch(ops[1])) {
        expect(ops[1].key).toBe('fullKey4');
        expect(JSON.parse(ops[1].value)).toEqual({ email: 'member3@example.com', name: 'Member Three' });
      }
    });

    it('should handle dataToUpdate as null', async () => {
      transactionsRunner.activateTransaction();

      (repository as any).resolvePaths.mockResolvedValue({ role: 'guest', id: '4' });
      (repository as any).generatePathCombinations.mockReturnValue([{ role: 'guest', id: '4' }]);
      (repository as any).get.mockResolvedValue({
        key: 'fullKey4',
        data: { email: 'user4@example.com', name: 'User Four' },
      });

      entitySchema.toFullKeyString
        .mockReturnValueOnce('fullKey4') // oldValidKey
        .mockReturnValueOnce('fullKey5'); // newValidKey

      await repository.updateByPartial(
        { role: 'guest', id: '4' },
        {
          pathToUpdate: { role: 'inactive' },
          dataToUpdate: null,
        }
      );

      const ops = transactionsRunner.getOperations();
      expect(ops).toHaveLength(2);

      expect(ops[0]).toEqual({ type: 'del', key: 'fullKey4' });

      if (isPutBatch(ops[1])) {
        expect(ops[1].key).toBe('fullKey5');
        expect(JSON.parse(ops[1].value)).toBeNull(); // Expecting null
      }
    });

    it('should handle multiple path combinations', async () => {
      transactionsRunner.activateTransaction();

      // Mock resolved paths and combinations
      (repository as any).resolvePaths.mockResolvedValue({ role: 'member', id: ['1', '2'] });
      (repository as any).generatePathCombinations.mockReturnValue([
        { role: 'member', id: '1' },
        { role: 'member', id: '2' },
      ]);

      // Mock get method to return existing records
      (repository as any).get
        .mockResolvedValueOnce({ key: 'fullKey1', data: { email: 'user1@example.com', name: 'User One' } })
        .mockResolvedValueOnce({ key: 'fullKey2', data: { email: 'user2@example.com', name: 'User Two' } });

      // Mock schema methods
      entitySchema.toFullKeyString
        .mockReturnValueOnce('fullKey1') // oldValidKey1
        .mockReturnValueOnce('fullKey3') // newValidKey1
        .mockReturnValueOnce('fullKey2') // oldValidKey2
        .mockReturnValueOnce('fullKey4'); // newValidKey2

      await repository.updateByPartial(
        { role: 'member', id: ['1', '2'] },
        {
          pathToUpdate: { role: 'admin' },
          dataToUpdate: { email: 'updated@example.com' },
        }
      );

      const ops = transactionsRunner.getOperations();
      expect(ops).toHaveLength(4);

      // First record operations
      expect(ops[0]).toEqual({ type: 'del', key: 'fullKey1' });
      if (isPutBatch(ops[1])) {
        expect(ops[1].key).toBe('fullKey3');
        expect(JSON.parse(ops[1].value)).toEqual({ email: 'updated@example.com', name: 'User One' });
      }

      // Second record operations
      expect(ops[2]).toEqual({ type: 'del', key: 'fullKey2' });
      if (isPutBatch(ops[3])) {
        expect(ops[3].key).toBe('fullKey4');
        expect(JSON.parse(ops[3].value)).toEqual({ email: 'updated@example.com', name: 'User Two' });
      }
    });
  });
});
