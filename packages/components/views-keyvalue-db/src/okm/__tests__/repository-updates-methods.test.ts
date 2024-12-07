import { AbstractBatch } from 'abstract-leveldown';
import { Repository } from '../repository';
import { ConnectionManager } from '../connection-manager';
import { EntitySchema } from '../schema';
import { TransactionsRunner } from '../transactions-runner';

function isPutBatch(op: AbstractBatch): op is { type: 'put'; key: string; value: string } {
  return op.type === 'put';
}

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

    jest.spyOn(repository as any, 'serialize').mockImplementation((val: any) => JSON.stringify(val));
    (repository as any).getByPartial = jest.fn();
    (repository as any).get = jest.fn();
    (repository as any).resolvePaths = jest.fn();
    (repository as any).generatePathCombinations = jest.fn();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('updateDataByPartial', () => {
    it('should throw if no active transaction', async () => {
      await expect(repository.updateDataByPartial({ age: 30 }, 'prefix')).rejects.toThrow(
        'updateDataByPartial must be called within an active transaction'
      );
    });

    it('should do nothing if no records', async () => {
      transactionsRunner.activateTransaction();
      (repository as any).getByPartial.mockResolvedValue([]);

      await repository.updateDataByPartial({ age: 30 }, 'prefix');
      expect(transactionsRunner.addOperations).not.toHaveBeenCalled();
    });

    it('should merge data for object records', async () => {
      transactionsRunner.activateTransaction();
      const records = [
        { key: 'k1', data: { name: 'Alice', age: 25 } },
        { key: 'k2', data: { name: 'Bob' } },
      ];
      (repository as any).getByPartial.mockResolvedValue(records);

      entitySchema.toFullKeyString.mockImplementation((k) => (typeof k === 'string' ? k : 'fullkey'));

      await repository.updateDataByPartial({ age: 30 }, 'prefix');

      const ops = transactionsRunner.getOperations();
      expect(ops).toHaveLength(2);
      if (isPutBatch(ops[0])) {
        const data1 = JSON.parse(ops[0].value as string);
        expect(data1).toEqual({ name: 'Alice', age: 30 });
      }

      if (isPutBatch(ops[1])) {
        const data2 = JSON.parse(ops[1].value as string);
        expect(data2).toEqual({ name: 'Bob', age: 30 });
      }
    });

    it('should replace data if existing not object', async () => {
      transactionsRunner.activateTransaction();
      const records = [{ key: 'k3', data: 'stringData' }];
      (repository as any).getByPartial.mockResolvedValue(records);
      entitySchema.toFullKeyString.mockReturnValue('fullKey3');

      await repository.updateDataByPartial({ status: 'updated' }, 'prefix');
      const ops = transactionsRunner.getOperations();
      expect(ops).toHaveLength(1);
      if (isPutBatch(ops[0])) {
        expect(JSON.parse(ops[0].value as string)).toEqual({ status: 'updated' });
      }
    });
  });

  describe('updateKey', () => {
    it('should throw if no active transaction', async () => {
      await expect(repository.updateKey({ id: 'x' }, { id: 'y' })).rejects.toThrow(
        'updateKey must be called within an active transaction'
      );
    });

    it('should resolve paths, generate combos, update keys', async () => {
      transactionsRunner.activateTransaction();
      (repository as any).resolvePaths.mockResolvedValue({ id: '123' });
      (repository as any).generatePathCombinations.mockReturnValue([{ id: '123' }]);
      (repository as any).get.mockResolvedValue({ key: { id: '123' }, data: { name: 'Test' } });
      entitySchema.toFullKeyString.mockReturnValueOnce('oldKey').mockReturnValueOnce('newKey');

      await repository.updateKey({ id: '123' }, { id: '999' });

      const ops = transactionsRunner.getOperations();
      expect(ops).toHaveLength(2);
      expect(ops[0]).toEqual({ type: 'del', key: 'oldKey' });
      expect(ops[1].type).toBe('put');
      if (isPutBatch(ops[1])) {
        expect(JSON.parse(ops[1].value as string)).toEqual({ name: 'Test' });
      }
    });

    it('should put null if no existing record found', async () => {
      transactionsRunner.activateTransaction();
      (repository as any).resolvePaths.mockResolvedValue({ id: 'xyz' });
      (repository as any).generatePathCombinations.mockReturnValue([{ id: 'xyz' }]);
      (repository as any).get.mockResolvedValue(null); // no record found
      entitySchema.toFullKeyString.mockReturnValueOnce('oldKeyN').mockReturnValueOnce('newKeyN');

      await repository.updateKey({ id: 'xyz' }, { id: '000' });

      const ops = transactionsRunner.getOperations();
      expect(ops).toHaveLength(2);
      expect(ops[0]).toEqual({ type: 'del', key: 'oldKeyN' });
      // put null data
      if (isPutBatch(ops[1])) {
        expect(JSON.parse(ops[1].value as string)).toBeNull();
      }
    });
  });

  describe('updateKeyByPartial', () => {
    it('should throw if no active transaction', async () => {
      await expect(repository.updateKeyByPartial({ id: 'x' }, { id: 'y' })).rejects.toThrow(
        'updateKeyByPartial must be called within an active transaction'
      );
    });

    it('should resolve paths, generate combos, and update keys for partial scenario', async () => {
      transactionsRunner.activateTransaction();
      (repository as any).resolvePaths.mockResolvedValue({ userId: ['u1', 'u2'] });
      (repository as any).generatePathCombinations.mockReturnValue([{ userId: 'u1' }, { userId: 'u2' }]);

      (repository as any).get
        .mockResolvedValueOnce({ key: { userId: 'u1' }, data: { name: 'Alice' } })
        .mockResolvedValueOnce({ key: { userId: 'u2' }, data: { name: 'Bob' } });
      entitySchema.toFullKeyString
        .mockReturnValueOnce('oldK1')
        .mockReturnValueOnce('newK1')
        .mockReturnValueOnce('oldK2')
        .mockReturnValueOnce('newK2');

      await repository.updateKeyByPartial({ userId: 'u1' }, { userId: 'updated' });

      const ops = transactionsRunner.getOperations();
      expect(ops).toHaveLength(4);
      expect(ops[0]).toEqual({ type: 'del', key: 'oldK1' });
      if (isPutBatch(ops[1])) {
        expect(JSON.parse(ops[1].value as string)).toEqual({ name: 'Alice' });
      }

      if (isPutBatch(ops[2])) {
        expect(ops[2]).toEqual({ type: 'del', key: 'oldK2' });
      }

      if (isPutBatch(ops[3])) {
        expect(JSON.parse(ops[3].value as string)).toEqual({ name: 'Bob' });
      }
    });

    it('should handle no existing record as null data in puts', async () => {
      transactionsRunner.activateTransaction();
      (repository as any).resolvePaths.mockResolvedValue({ userId: ['uX'] });
      (repository as any).generatePathCombinations.mockReturnValue([{ userId: 'uX' }]);
      (repository as any).get.mockResolvedValue(null); // no record
      entitySchema.toFullKeyString.mockReturnValueOnce('oldKx').mockReturnValueOnce('newKx');

      await repository.updateKeyByPartial({ userId: 'uX' }, { userId: 'changed' });
      const ops = transactionsRunner.getOperations();
      expect(ops).toHaveLength(2);
      expect(ops[0]).toEqual({ type: 'del', key: 'oldKx' });

      if (isPutBatch(ops[1])) {
        expect(JSON.parse(ops[1].value as string)).toBeNull();
      }
    });

    describe('updateData', () => {
      it('should update data by calling put directly', async () => {
        const keyObj = { id: '1' };
        const data = { name: 'NewName' };

        repository.put = jest.fn().mockResolvedValue(null);

        await repository.updateData(keyObj, data);

        expect(repository.put).toHaveBeenCalledWith(keyObj, data);
      });
    });
  });
});
