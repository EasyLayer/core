import { EntitySchema, SchemaDefinition } from '../schema';

describe('EntitySchema', () => {
  describe('Constructor', () => {
    it('should initialize correctly with valid schema definition', () => {
      const schemaDefinition: SchemaDefinition = {
        prefix: 'test',
        separator: ':',
        paths: {
          id: { type: 'dynamic', required: true },
          type: { type: 'static', required: true, value: 'user' },
        },
        data: { type: 'object' },
      };

      const entitySchema = new EntitySchema(schemaDefinition);

      expect(entitySchema.prefix).toBe('test');
      expect(entitySchema.separator).toBe(':');
      expect(entitySchema.paths).toEqual(schemaDefinition.paths);
      expect(entitySchema.data).toEqual(schemaDefinition.data);
    });
  });

  describe('generateKey', () => {
    const schemaDefinition: SchemaDefinition = {
      prefix: 'user',
      separator: ':',
      paths: {
        id: { type: 'dynamic', required: true },
        role: { type: 'static', required: true, value: 'admin' },
      },
      data: { type: 'object' },
    };

    const entitySchema = new EntitySchema(schemaDefinition);

    it('should generate key correctly with valid dynamic paths', () => {
      const paths = { id: '12345' };
      const expectedKey = 'user:12345:admin';

      const key = entitySchema.generateKey(paths);

      expect(key).toBe(expectedKey);
    });

    it('should throw an error when a required dynamic path is missing', () => {
      const paths = {}; // 'id' is missing

      expect(() => entitySchema.generateKey(paths)).toThrow('Missing required dynamic path: id');
    });

    it('should generate key correctly with multiple dynamic paths', () => {
      const multiDynamicSchema: SchemaDefinition = {
        prefix: 'order',
        separator: '-',
        paths: {
          userId: { type: 'dynamic', required: true },
          orderId: { type: 'dynamic', required: true },
          status: { type: 'static', required: true, value: 'active' },
        },
        data: { type: 'string' },
      };

      const multiEntitySchema = new EntitySchema(multiDynamicSchema);
      const paths = { userId: 'u100', orderId: 'o200' };
      const expectedKey = 'order-u100-o200-active';

      const key = multiEntitySchema.generateKey(paths);

      expect(key).toBe(expectedKey);
    });

    it('should handle optional dynamic paths if present', () => {
      const optionalDynamicSchema: SchemaDefinition = {
        prefix: 'product',
        separator: ':',
        paths: {
          category: { type: 'static', required: true, value: 'electronics' },
          subCategory: { type: 'dynamic', required: false },
          id: { type: 'dynamic', required: true },
        },
        data: { type: 'number' },
      };

      const optionalEntitySchema = new EntitySchema(optionalDynamicSchema);
      const paths = { id: 'p123' };
      const expectedKey = 'product:electronics:p123';

      const key = optionalEntitySchema.generateKey(paths);

      expect(key).toBe(expectedKey);
    });

    it('should include optional dynamic paths if provided', () => {
      const optionalDynamicSchema: SchemaDefinition = {
        prefix: 'product',
        separator: ':',
        paths: {
          category: { type: 'static', required: true, value: 'electronics' },
          subCategory: { type: 'dynamic', required: false },
          id: { type: 'dynamic', required: true },
        },
        data: { type: 'number' },
      };

      const optionalEntitySchema = new EntitySchema(optionalDynamicSchema);
      const paths = { id: 'p123', subCategory: 'smartphones' };
      const expectedKey = 'product:electronics:smartphones:p123';

      const key = optionalEntitySchema.generateKey(paths);

      expect(key).toBe(expectedKey);
    });
  });

  describe('generatePrefix', () => {
    it('should generate prefix correctly without paths', () => {
      const schemaDefinition: SchemaDefinition = {
        prefix: 'inventory',
        separator: '/',
        paths: {},
        data: { type: 'object' },
      };

      const entitySchema = new EntitySchema(schemaDefinition);

      const prefix = entitySchema.generatePrefix();
      expect(prefix).toBe('inventory');
    });

    it('should generate prefix correctly with some dynamic paths provided', () => {
      const schemaDefinition: SchemaDefinition = {
        prefix: 'inventory',
        separator: '/',
        paths: {
          category: { type: 'dynamic', required: true },
          subCategory: { type: 'dynamic', required: false },
          type: { type: 'static', required: false, value: 'item' },
        },
        data: { type: 'object' },
      };

      const entitySchema = new EntitySchema(schemaDefinition);
      const paths = { category: 'electronics' };
      const expectedPrefix = 'inventory/electronics';

      const prefix = entitySchema.generatePrefix(paths);

      expect(prefix).toBe(expectedPrefix);
    });

    it('should stop prefix generation at the first undefined dynamic path', () => {
      const schemaDefinition: SchemaDefinition = {
        prefix: 'inventory',
        separator: '/',
        paths: {
          category: { type: 'dynamic', required: true },
          subCategory: { type: 'dynamic', required: false },
          type: { type: 'static', required: true, value: 'item' },
        },
        data: { type: 'object' },
      };

      const entitySchema = new EntitySchema(schemaDefinition);
      const paths = { category: 'electronics' }; // subCategory is undefined

      const expectedPrefix = 'inventory/electronics/item';

      const prefix = entitySchema.generatePrefix(paths);

      expect(prefix).toBe(expectedPrefix);
    });

    it('should include all provided dynamic paths in the prefix', () => {
      const schemaDefinition: SchemaDefinition = {
        prefix: 'inventory',
        separator: '/',
        paths: {
          category: { type: 'dynamic', required: true },
          subCategory: { type: 'dynamic', required: false },
          type: { type: 'static', required: true, value: 'item' },
        },
        data: { type: 'object' },
      };

      const entitySchema = new EntitySchema(schemaDefinition);
      const paths = { category: 'electronics', subCategory: 'smartphones' };
      const expectedPrefix = 'inventory/electronics/smartphones/item';

      const prefix = entitySchema.generatePrefix(paths);

      expect(prefix).toBe(expectedPrefix);
    });
  });

  describe('parseKey', () => {
    const schemaDefinition: SchemaDefinition = {
      prefix: 'user',
      separator: ':',
      paths: {
        id: { type: 'dynamic', required: true },
        role: { type: 'static', required: true, value: 'admin' },
      },
      data: { type: 'object' },
    };

    const entitySchema = new EntitySchema(schemaDefinition);

    it('should parse a valid key correctly', () => {
      const key = 'user:12345:admin';
      const expectedPaths = { id: '12345' };

      const paths = entitySchema.parseKey(key);

      expect(paths).toEqual(expectedPaths);
    });

    it('should throw an error if key does not start with the prefix', () => {
      const invalidKey = 'invalid:12345:admin';

      expect(() => entitySchema.parseKey(invalidKey)).toThrow('Key does not match the schema paths');
    });

    it('should throw an error if static path does not match', () => {
      const invalidKey = 'user:12345:superadmin';

      expect(() => entitySchema.parseKey(invalidKey)).toThrow('Static path mismatch for role');
    });

    it('should throw an error if key has missing path segments', () => {
      const incompleteKey = 'user:12345';

      expect(() => entitySchema.parseKey(incompleteKey)).toThrow('Key does not match the schema paths');
    });

    it('should throw an error if key has extra path segments', () => {
      const extraKey = 'user:12345:admin:extra';

      expect(() => entitySchema.parseKey(extraKey)).toThrow('Key does not match the schema paths');
    });

    it('should parse key correctly with multiple dynamic paths', () => {
      const multiDynamicSchema: SchemaDefinition = {
        prefix: 'order',
        separator: '-',
        paths: {
          userId: { type: 'dynamic', required: true },
          orderId: { type: 'dynamic', required: true },
          status: { type: 'static', required: true, value: 'active' },
        },
        data: { type: 'string' },
      };

      const multiEntitySchema = new EntitySchema(multiDynamicSchema);
      const key = 'order-u100-o200-active';
      const expectedPaths = { userId: 'u100', orderId: 'o200' };

      const paths = multiEntitySchema.parseKey(key);

      expect(paths).toEqual(expectedPaths);
    });

    it('should handle keys with different separators', () => {
      const dashSeparatorSchema: SchemaDefinition = {
        prefix: 'product',
        separator: '-',
        paths: {
          category: { type: 'static', required: true, value: 'electronics' },
          id: { type: 'dynamic', required: true },
        },
        data: { type: 'number' },
      };

      const dashSchema = new EntitySchema(dashSeparatorSchema);
      const key = 'product-electronics-p123';
      const expectedPaths = { id: 'p123' };

      const paths = dashSchema.parseKey(key);

      expect(paths).toEqual(expectedPaths);
    });

    it('should throw an error when parsing key with missing required dynamic path', () => {
      const incompleteKey = 'user::admin'; // Missing id

      expect(() => entitySchema.parseKey(incompleteKey)).toThrow('Missing required path: id');
    });
  });

  describe('Different Prefixes and Complex Scenarios', () => {
    it('should handle different prefixes correctly', () => {
      const schemaA: SchemaDefinition = {
        prefix: 'alpha',
        separator: '|',
        paths: {
          code: { type: 'dynamic', required: true },
          type: { type: 'static', required: true, value: 'A' },
        },
        data: { type: 'string' },
      };

      const schemaB: SchemaDefinition = {
        prefix: 'beta',
        separator: '-',
        paths: {
          id: { type: 'dynamic', required: true },
          category: { type: 'static', required: true, value: 'B' },
        },
        data: { type: 'number' },
      };

      const entitySchemaA = new EntitySchema(schemaA);
      const entitySchemaB = new EntitySchema(schemaB);

      const keyA = entitySchemaA.generateKey({ code: 'X100' });
      const expectedKeyA = 'alpha|X100|A';

      const keyB = entitySchemaB.generateKey({ id: 'Y200' });
      const expectedKeyB = 'beta-Y200-B';

      expect(keyA).toBe(expectedKeyA);
      expect(keyB).toBe(expectedKeyB);

      const parsedPathsA = entitySchemaA.parseKey(keyA);
      const parsedPathsB = entitySchemaB.parseKey(keyB);

      expect(parsedPathsA).toEqual({ code: 'X100' });
      expect(parsedPathsB).toEqual({ id: 'Y200' });
    });

    it('should validate multiple schemas with different prefixes', () => {
      const schemaDefinitions: SchemaDefinition[] = [
        {
          prefix: 'user',
          separator: ':',
          paths: {
            id: { type: 'dynamic', required: true },
            role: { type: 'static', required: true, value: 'admin' },
          },
          data: { type: 'object' },
        },
        {
          prefix: 'product',
          separator: '/',
          paths: {
            category: { type: 'static', required: true, value: 'electronics' },
            id: { type: 'dynamic', required: true },
          },
          data: { type: 'number' },
        },
      ];

      const entitySchemas = schemaDefinitions.map((def) => new EntitySchema(def));

      const [userSchema, productSchema] = entitySchemas;

      const userKey = userSchema.generateKey({ id: 'u123' });
      const expectedUserKey = 'user:u123:admin';

      const productKey = productSchema.generateKey({ id: 'p456' });
      const expectedProductKey = 'product/electronics/p456';

      expect(userKey).toBe(expectedUserKey);
      expect(productKey).toBe(expectedProductKey);

      const parsedUserPaths = userSchema.parseKey(userKey);
      const parsedProductPaths = productSchema.parseKey(productKey);

      expect(parsedUserPaths).toEqual({ id: 'u123' });
      expect(parsedProductPaths).toEqual({ id: 'p456' });
    });

    it('should handle complex schemas with multiple static and dynamic paths', () => {
      const complexSchema: SchemaDefinition = {
        prefix: 'complex',
        separator: '|',
        paths: {
          region: { type: 'static', required: true, value: 'us-west' },
          service: { type: 'dynamic', required: true },
          version: { type: 'static', required: true, value: 'v1' },
          instance: { type: 'dynamic', required: false },
        },
        data: { type: 'object' },
      };

      const entitySchema = new EntitySchema(complexSchema);

      const keyWithAllPaths = entitySchema.generateKey({ service: 'auth', instance: 'i789' });
      const expectedKeyWithAllPaths = 'complex|us-west|auth|v1|i789';

      const keyWithoutOptionalPath = entitySchema.generateKey({ service: 'auth' });
      const expectedKeyWithoutOptionalPath = 'complex|us-west|auth|v1';

      expect(keyWithAllPaths).toBe(expectedKeyWithAllPaths);
      expect(keyWithoutOptionalPath).toBe(expectedKeyWithoutOptionalPath);

      const parsedPathsWithAll = entitySchema.parseKey(keyWithAllPaths);
      const parsedPathsWithoutOptional = entitySchema.parseKey(keyWithoutOptionalPath);

      expect(parsedPathsWithAll).toEqual({ service: 'auth', instance: 'i789' });
      expect(parsedPathsWithoutOptional).toEqual({ service: 'auth' });
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty paths in schema definition', () => {
      const emptyPathsSchema: SchemaDefinition = {
        prefix: 'empty',
        separator: ':',
        paths: {},
        data: { type: 'string' },
      };

      const entitySchema = new EntitySchema(emptyPathsSchema);

      const key = entitySchema.generateKey({});
      expect(key).toBe('empty');

      const parsedPaths = entitySchema.parseKey('empty');
      expect(parsedPaths).toEqual({});
    });

    it('should handle schemas with only static paths', () => {
      const staticOnlySchema: SchemaDefinition = {
        prefix: 'static',
        separator: '/',
        paths: {
          type: { type: 'static', required: true, value: 'fixed' },
          category: { type: 'static', required: true, value: 'constant' },
        },
        data: { type: 'boolean' },
      };

      const entitySchema = new EntitySchema(staticOnlySchema);

      const key = entitySchema.generateKey({});
      const expectedKey = 'static/fixed/constant';

      expect(key).toBe(expectedKey);

      const parsedPaths = entitySchema.parseKey(expectedKey);
      expect(parsedPaths).toEqual({});
    });

    it('should handle schemas with only dynamic paths', () => {
      const dynamicOnlySchema: SchemaDefinition = {
        prefix: 'dynamic',
        separator: '-',
        paths: {
          userId: { type: 'dynamic', required: true },
          sessionId: { type: 'dynamic', required: true },
        },
        data: { type: 'array' },
      };

      const entitySchema = new EntitySchema(dynamicOnlySchema);

      const paths = { userId: 'u001', sessionId: 's123' };
      const expectedKey = 'dynamic-u001-s123';

      const key = entitySchema.generateKey(paths);
      expect(key).toBe(expectedKey);

      const parsedPaths = entitySchema.parseKey(key);
      expect(parsedPaths).toEqual(paths);
    });

    it('should throw an error when generating key with undefined dynamic path', () => {
      const schemaDefinition: SchemaDefinition = {
        prefix: 'test',
        separator: ':',
        paths: {
          id: { type: 'dynamic', required: true },
          name: { type: 'dynamic', required: true },
        },
        data: { type: 'object' },
      };

      const entitySchema = new EntitySchema(schemaDefinition);

      const paths = { id: '123' }; // Missing 'name'

      expect(() => entitySchema.generateKey(paths)).toThrow('Missing required dynamic path: name');
    });

    it('should throw an error when parsing key with incorrect number of segments', () => {
      const schemaDefinition: SchemaDefinition = {
        prefix: 'sample',
        separator: ':',
        paths: {
          part1: { type: 'dynamic', required: true },
          part2: { type: 'static', required: true, value: 'fixed' },
        },
        data: { type: 'object' },
      };

      const entitySchema = new EntitySchema(schemaDefinition);

      const invalidKey = 'sample:dynamic'; // Missing 'fixed'

      expect(() => entitySchema.parseKey(invalidKey)).toThrow('Key does not match the schema paths');
    });
  });
});
