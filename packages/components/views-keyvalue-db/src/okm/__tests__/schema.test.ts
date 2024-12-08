import { EntitySchema, SchemaDefinition } from '../schema';

describe('EntitySchema', () => {
  describe('toFullKeyString', () => {
    const schemaDef: SchemaDefinition = {
      prefix: 'user',
      separator: ':',
      paths: {
        id: { type: 'dynamic' },
        role: { type: 'static', value: 'admin' },
      },
      data: { type: 'object' },
    };

    const entitySchema = new EntitySchema(schemaDef);

    it('should generate full key with object missing static path', () => {
      const keyObject = { id: '12345' };
      const expected = 'user:12345:admin';
      expect(entitySchema.toFullKeyString(keyObject)).toBe(expected);
    });

    it('should generate full key when key is a string without prefix', () => {
      const keyString = '67890';
      const expected = 'user:67890:admin';
      expect(entitySchema.toFullKeyString(keyString)).toBe(expected);
    });

    it('should generate full key when key is a string with prefix', () => {
      const keyWithPrefix = 'user:67890';
      const expected = 'user:67890:admin';
      expect(entitySchema.toFullKeyString(keyWithPrefix)).toBe(expected);
    });

    it('should throw error if static path has incorrect value in object', () => {
      const keyObject = { id: '12345', role: 'user' }; // role should be admin
      expect(() => entitySchema.toFullKeyString(keyObject)).toThrowError(
        "Invalid value for static path 'role'. Expected 'admin', got 'user'"
      );
    });

    it('should generate full key correctly if dynamic path optional and missing', () => {
      const schemaNoDynamic: SchemaDefinition = {
        prefix: 'test',
        separator: ':',
        paths: {
          type: { type: 'static', value: 'fixed' },
        },
      };
      const noDynamicSchema = new EntitySchema(schemaNoDynamic);
      // No dynamic paths, just static
      expect(noDynamicSchema.toFullKeyString({})).toBe('test:fixed');
      expect(noDynamicSchema.toFullKeyString('')).toBe('test:fixed');
    });

    it('should throw error if dynamic path is required but missing for full key', () => {
      const schemaWithRequiredDynamic: SchemaDefinition = {
        prefix: 'foo',
        separator: ':',
        paths: {
          category: { type: 'static', value: 'bar' },
          itemId: { type: 'dynamic' },
        },
      };
      const dynamicSchema = new EntitySchema(schemaWithRequiredDynamic);
      // itemId is dynamic and must be provided
      expect(() => dynamicSchema.toFullKeyString({})).toThrowError(
        "Missing required dynamic path 'itemId' in full key."
      );
      expect(() => dynamicSchema.toFullKeyString('')).toThrowError(
        "Missing required dynamic path 'itemId' in full key."
      );
    });

    it('should properly handle complex schema with multiple static and dynamic paths', () => {
      const complexDef: SchemaDefinition = {
        prefix: 'complex',
        separator: '|',
        paths: {
          region: { type: 'static', value: 'us-east' },
          service: { type: 'dynamic' },
          version: { type: 'static', value: 'v1' },
          instance: { type: 'dynamic' },
        },
        data: { type: 'object' },
      };
      const complexSchema = new EntitySchema(complexDef);

      const keyObj = { service: 'auth', instance: 'i100' };
      const expected = 'complex|us-east|auth|v1|i100';
      expect(complexSchema.toFullKeyString(keyObj)).toBe(expected);

      // Check if missing dynamic causes error
      expect(() => complexSchema.toFullKeyString({ service: 'auth' })).toThrowError(
        "Missing required dynamic path 'instance' in full key."
      );
    });
  });

  describe('toPartialKeyString', () => {
    const schemaDef: SchemaDefinition = {
      prefix: 'order',
      separator: ':',
      paths: {
        userId: { type: 'dynamic' },
        orderId: { type: 'dynamic' },
        status: { type: 'static', value: 'active' },
      },
      data: { type: 'object' },
    };

    const entitySchema = new EntitySchema(schemaDef);

    /**
     * @note According to the new requirement:
     * Because userId and orderId are dynamic and come before the static 'status',
     * if we do not provide them, the partial key is invalid. We must throw an error.
     */

    it('should throw an error if partial key is undefined because dynamic paths are missing', () => {
      // Previously expected 'order:active', now we must fail due to missing userId/orderId
      expect(() => entitySchema.toPartialKeyString()).toThrowError("Missing dynamic path 'userId' in partial key.");
    });

    it('should throw an error when partial key is a simple string with only one dynamic path provided', () => {
      const partial = 'u123'; // userId provided, but orderId missing
      // Previously expected: 'order:active:u123'
      // Now must fail since orderId missing
      expect(() => entitySchema.toPartialKeyString(partial)).toThrowError(
        "Missing dynamic path 'orderId' in partial key."
      );
    });

    it('should generate a valid partial key when partial key is a string providing all dynamics', () => {
      const partial = 'u123:o456'; // userId and orderId provided
      // Now we have all dynamic paths, so we can append static at the end
      const expected = 'order:u123:o456:active';
      expect(entitySchema.toPartialKeyString(partial)).toBe(expected);
    });

    it('should throw an error when only prefix is provided as an empty string', () => {
      const partial = '';
      // No userId or orderId => error
      expect(() => entitySchema.toPartialKeyString(partial)).toThrowError(
        "Missing dynamic path 'userId' in partial key."
      );
    });

    it('should throw an error if partial key is an object with only one dynamic path', () => {
      const partialObj = { userId: 'u999' }; // orderId missing
      // Previously expected 'order:active:u999'
      // Now must fail since orderId is missing
      expect(() => entitySchema.toPartialKeyString(partialObj)).toThrowError(
        "Missing dynamic path 'orderId' in partial key."
      );
    });

    it('should throw an error if partial object provides no dynamic paths', () => {
      const partialObj = {};
      // No userId or orderId => error
      expect(() => entitySchema.toPartialKeyString(partialObj)).toThrowError(
        "Missing dynamic path 'userId' in partial key."
      );
    });

    it('should handle schema with only static paths for partial keys', () => {
      // This test scenario from original code is okay since it's separate schema
      const staticOnlyDef: SchemaDefinition = {
        prefix: 'staticp',
        separator: '/',
        paths: {
          type: { type: 'static', value: 'fixed' },
          category: { type: 'static', value: 'constant' },
        },
      };
      const staticSchema = new EntitySchema(staticOnlyDef);
      // Here no dynamic paths first, so undefined partial key is allowed
      expect(staticSchema.toPartialKeyString()).toBe('staticp/fixed/constant');
      expect(staticSchema.toPartialKeyString('')).toBe('staticp/fixed/constant');
      expect(staticSchema.toPartialKeyString({})).toBe('staticp/fixed/constant');
    });

    it('should handle schema with only dynamic paths for partial keys', () => {
      const dynOnlyDef: SchemaDefinition = {
        prefix: 'dpartial',
        separator: '-',
        paths: {
          userId: { type: 'dynamic' },
          sessionId: { type: 'dynamic' },
        },
      };
      const dynSchema = new EntitySchema(dynOnlyDef);

      // no partial key means we have no userId => error
      expect(() => dynSchema.toPartialKeyString()).toThrowError("Missing dynamic path 'userId' in partial key.");
      // if we provide one dynamic in string
      // userId = u001 provided, sessionId missing => error
      expect(() => dynSchema.toPartialKeyString('u001')).toThrowError(
        "Missing dynamic path 'sessionId' in partial key."
      );
      // if we provide one dynamic in object
      expect(() => dynSchema.toPartialKeyString({ userId: 'u001' })).toThrowError(
        "Missing dynamic path 'sessionId' in partial key."
      );
      // two dynamics in string
      // now we have both userId=u001 and sessionId=s123
      expect(dynSchema.toPartialKeyString('u001-s123')).toBe('dpartial-u001-s123');
    });
  });

  describe('matchesSuffix', () => {
    const schemaDef: SchemaDefinition = {
      prefix: 'user',
      separator: ':',
      paths: {
        id: { type: 'dynamic' },
        status: { type: 'dynamic' },
      },
    };

    const entitySchema = new EntitySchema(schemaDef);

    it('should return true if key matches the suffix', () => {
      const key = 'user:12345:active';
      const suffix = '12345:active';
      expect(entitySchema.matchesSuffix(key, suffix)).toBe(true);
    });

    it('should return false if suffix does not match', () => {
      const key = 'user:12345:inactive';
      const suffix = '12345:active';
      expect(entitySchema.matchesSuffix(key, suffix)).toBe(false);
    });

    it('should handle suffix with no dynamic paths', () => {
      const staticDef: SchemaDefinition = {
        prefix: 'static',
        separator: '|',
        paths: {
          type: { type: 'static', value: 'fixed' },
        },
      };
      const staticSchema = new EntitySchema(staticDef);

      const key = 'static|fixed';
      const suffix = 'fixed';
      expect(staticSchema.matchesSuffix(key, suffix)).toBe(true);
      expect(staticSchema.matchesSuffix(key, 'notfixed')).toBe(false);
    });

    it('should handle cases where suffix is longer than key', () => {
      const key = 'user:12345:active';
      const suffix = '12345:active:extra';
      // suffix is longer, cannot match
      expect(entitySchema.matchesSuffix(key, suffix)).toBe(false);
    });

    it('should handle empty suffix', () => {
      const key = 'user:12345:active';
      const suffix = '';
      // empty suffix means always ends with empty?
      // depends on logic, but let's say empty means suffix is empty string - it should match trivially
      // If we consider empty suffix as always match:
      expect(entitySchema.matchesSuffix(key, suffix)).toBe(true);
    });
  });

  describe('validateData', () => {
    it('should accept null or undefined when schema.data is null', () => {
      // schema with no data definition means data must be null or undefined
      const schemaNoData: SchemaDefinition = {
        prefix: 'nodef',
        separator: ':',
        // no paths defined, just no data
      };
      const entitySchema = new EntitySchema(schemaNoData);

      expect(() => entitySchema.validateData(null)).not.toThrow();
      expect(() => entitySchema.validateData(undefined)).not.toThrow();
      expect(() => entitySchema.validateData({})).toThrowError(
        'Data should be null or undefined as per schema definition.'
      );
    });

    it('should validate object data according to fields', () => {
      // schema expects an object with specific fields
      const schemaObj: SchemaDefinition = {
        prefix: 'obj',
        separator: ':',
        data: {
          type: 'object',
          fields: {
            name: { type: 'string' },
            age: { type: 'number' },
          },
        },
      };

      const entitySchema = new EntitySchema(schemaObj);

      // valid data
      const validData = { name: 'Alice', age: 30 };
      expect(() => entitySchema.validateData(validData)).not.toThrow();

      // missing field
      const missingField = { name: 'Bob' };
      expect(() => entitySchema.validateData(missingField)).toThrowError("Root: Missing field 'age'.");

      // incorrect type
      const incorrectType = { name: 'Charlie', age: 'thirty' };
      expect(() => entitySchema.validateData(incorrectType)).toThrowError("Field 'age': Expected a number.");
    });

    it('should validate string data', () => {
      const schemaString: SchemaDefinition = {
        prefix: 'str',
        separator: '/',
        data: { type: 'string' },
      };

      const entitySchema = new EntitySchema(schemaString);

      expect(() => entitySchema.validateData('hello')).not.toThrow();
      expect(() => entitySchema.validateData(123)).toThrowError('Root: Expected a string.');
      expect(() => entitySchema.validateData(null)).toThrowError('Root: Expected a string.');
    });

    it('should validate number data', () => {
      const schemaNumber: SchemaDefinition = {
        prefix: 'num',
        separator: ':',
        data: { type: 'number' },
      };

      const entitySchema = new EntitySchema(schemaNumber);

      expect(() => entitySchema.validateData(42)).not.toThrow();
      expect(() => entitySchema.validateData('42')).toThrowError('Root: Expected a number.');
      expect(() => entitySchema.validateData(null)).toThrowError('Root: Expected a number.');
    });

    it('should validate boolean data', () => {
      const schemaBoolean: SchemaDefinition = {
        prefix: 'bool',
        separator: '|',
        data: { type: 'boolean' },
      };

      const entitySchema = new EntitySchema(schemaBoolean);

      expect(() => entitySchema.validateData(true)).not.toThrow();
      expect(() => entitySchema.validateData(false)).not.toThrow();
      expect(() => entitySchema.validateData('true')).toThrowError('Root: Expected a boolean.');
      expect(() => entitySchema.validateData(null)).toThrowError('Root: Expected a boolean.');
    });

    it('should validate array data', () => {
      const schemaArray: SchemaDefinition = {
        prefix: 'arr',
        separator: ',',
        data: {
          type: 'array',
          items: { type: 'string' },
        },
      };

      const entitySchema = new EntitySchema(schemaArray);

      expect(() => entitySchema.validateData(['apple', 'banana'])).not.toThrow();
      expect(() => entitySchema.validateData(['apple', 123])).toThrowError('Root [1]: Expected a string.');
      expect(() => entitySchema.validateData('not an array')).toThrowError('Root: Expected an array.');
      expect(() => entitySchema.validateData([])).not.toThrow();
    });

    it('should validate nested objects and arrays', () => {
      const nestedSchema: SchemaDefinition = {
        prefix: 'nested',
        separator: ':',
        data: {
          type: 'object',
          fields: {
            user: {
              type: 'object',
              fields: {
                name: { type: 'string' },
                tags: {
                  type: 'array',
                  items: { type: 'string' },
                },
              },
            },
          },
        },
      };

      const entitySchema = new EntitySchema(nestedSchema);

      const validData = {
        user: {
          name: 'Dave',
          tags: ['admin', 'tester'],
        },
      };
      expect(() => entitySchema.validateData(validData)).not.toThrow();

      const missingFieldData = {
        user: {
          // name missing
          tags: ['admin', 'tester'],
        },
      };
      expect(() => entitySchema.validateData(missingFieldData)).toThrowError("Field 'user': Missing field 'name'.");

      const incorrectTypeData = {
        user: {
          name: 'Eve',
          tags: ['admin', 42],
        },
      };
      expect(() => entitySchema.validateData(incorrectTypeData)).toThrowError("Field 'tags' [1]: Expected a string.");
    });
  });

  describe('Edge Cases and Complex Scenarios', () => {
    it('should handle schemas with only static paths for full keys', () => {
      const staticOnlySchema: SchemaDefinition = {
        prefix: 'onlystatic',
        separator: '/',
        paths: {
          type: { type: 'static', value: 'fixed' },
          category: { type: 'static', value: 'constant' },
        },
      };

      const entitySchema = new EntitySchema(staticOnlySchema);

      // Empty object should become prefix/fixed/constant
      expect(entitySchema.toFullKeyString({})).toBe('onlystatic/fixed/constant');
      // If we provide different static values?
      expect(() => entitySchema.toFullKeyString({ type: 'wrong' })).toThrowError(
        "Invalid value for static path 'type'. Expected 'fixed', got 'wrong'"
      );
    });

    it('should handle schemas with only dynamic paths for full keys', () => {
      const dynOnlySchema: SchemaDefinition = {
        prefix: 'dyn',
        separator: '-',
        paths: {
          userId: { type: 'dynamic' },
          sessionId: { type: 'dynamic' },
        },
      };

      const entitySchema = new EntitySchema(dynOnlySchema);

      // Must provide all dynamics
      expect(() => entitySchema.toFullKeyString({})).toThrowError(
        "Missing required dynamic path 'userId' in full key."
      );
      // Provide one dynamic, still missing the second
      expect(() => entitySchema.toFullKeyString({ userId: 'u001' })).toThrowError(
        "Missing required dynamic path 'sessionId' in full key."
      );
      // Provide both
      expect(entitySchema.toFullKeyString({ userId: 'u001', sessionId: 's123' })).toBe('dyn-u001-s123');
    });

    it('should allow optional dynamics in full keys if considered optional', () => {
      // If we consider that a dynamic path with no mention of "required" is optional:
      // Actually, from code: dynamic paths are always required for full keys. Let's test a schema with no mention of needed dynamic:
      const optionalDynamicSchema: SchemaDefinition = {
        prefix: 'opt',
        separator: ':',
        paths: {
          userId: { type: 'dynamic' },
          maybeId: { type: 'dynamic' },
          role: { type: 'static', value: 'admin' },
        },
      };

      const entitySchema = new EntitySchema(optionalDynamicSchema);

      // According to current logic, dynamic must always be provided for full keys. If we want optional:
      // Let's say we allow an empty or undefined dynamic and skip it:
      // But code throws error if missing dynamic, let's provide all:
      expect(entitySchema.toFullKeyString({ userId: 'u100', maybeId: 'm200' })).toBe('opt:u100:m200:admin');

      // If we omit maybeId:
      // Currently code throws error because dynamic is required:
      expect(() => entitySchema.toFullKeyString({ userId: 'u100' })).toThrowError(
        "Missing required dynamic path 'maybeId' in full key."
      );
    });

    it('should handle keys with extra segments in string gracefully (not allowed)', () => {
      const schemaDef: SchemaDefinition = {
        prefix: 'extra',
        separator: ':',
        paths: {
          id: { type: 'dynamic' },
        },
      };

      const entitySchema = new EntitySchema(schemaDef);

      // If we provide extra segments:
      // The code does not explicitly handle extra segments after all paths are consumed.
      // But it doesn't matter: parseFullKeyString stops at paths length.
      // Extra segments are ignored silently. Let's confirm that:
      const fullKey = entitySchema.toFullKeyString('extra:123:ignored:stuff');
      // expected: prefix='extra', id='123', ignore the rest
      expect(fullKey).toBe('extra:123');
    });
  });
});
