interface PathDefinition {
  type: 'static' | 'dynamic'; // Type of the path
  required: boolean; // Whether the path is required
  value?: string; // Value for static paths
}

export interface ValueDefinition {
  type: 'object' | 'string' | 'number' | 'boolean' | 'array'; // Type of the stored value
  fields?: Record<string, ValueDefinition>; // For objects
  items?: ValueDefinition; // For arrays
}

export interface SchemaDefinition {
  prefix: string; // Key prefix
  separator: string; // Separator between key parts
  paths: Record<string, PathDefinition>; // Description of key paths
  data: ValueDefinition; // Description of the stored value
}

export class EntitySchema {
  prefix: string;
  separator: string;
  paths: Record<string, PathDefinition>;
  data: ValueDefinition;

  constructor(definition: SchemaDefinition) {
    this.prefix = definition.prefix;
    this.separator = definition.separator;
    this.paths = definition.paths;
    this.data = definition.data;
  }

  /**
   * Validates that all required dynamic paths are present in the key.
   * @param key Key as an object
   */
  private validateRequiredPaths(key: Record<string, string>): void {
    for (const [pathName, definition] of Object.entries(this.paths)) {
      if (
        definition.type === 'dynamic' &&
        definition.required &&
        (key[pathName] === undefined || key[pathName] === null || key[pathName] === '')
      ) {
        throw new Error(`Missing required dynamic path: ${pathName}`);
      }
    }
  }

  /**
   * Generates a string key based on the input, adding prefix if necessary and validating against the schema.
   * Prevents duplicate prefixes.
   * @param key Key as an object or string
   * @returns Generated string key
   */
  public generateKey(key: Record<string, string> | string): string {
    let paths: Record<string, string>;

    if (typeof key === 'string') {
      // If key is a string, check for prefix and prevent duplication
      const expectedPrefix = this.prefix + this.separator;
      if (!key.startsWith(expectedPrefix)) {
        throw new Error(`Key string must start with the prefix '${this.prefix}${this.separator}'`);
      }

      const withoutPrefix = key.slice(expectedPrefix.length);
      if (withoutPrefix.startsWith(this.prefix + this.separator)) {
        throw new Error('Duplicate prefix detected in the key string');
      }

      // Parse the key to extract dynamic paths
      paths = this.parseKey(key);
    } else {
      // If key is an object, validate required paths
      this.validateRequiredPaths(key);
      paths = key;
    }

    // Generate path segments based on the schema
    const pathSegments = Object.entries(this.paths).reduce<string[]>((segments, [name, def]) => {
      if (def.type === 'static') {
        segments.push(def.value!);
      } else {
        if (paths[name] !== undefined && paths[name] !== null && paths[name] !== '') {
          segments.push(String(paths[name]));
        } else if (def.required) {
          // This condition should already be handled by validateRequiredPaths
          throw new Error(`Missing required path: ${name}`);
        }
        // If the path is optional and not provided, skip it
      }
      return segments;
    }, []);

    return [this.prefix, ...pathSegments].join(this.separator);
  }

  /**
   * Generates a prefix based on the provided dynamic path values.
   * @param paths Dynamic path values
   * @returns Generated prefix string
   */
  public generatePrefix(paths?: Record<string, string>): string {
    const keyParts: string[] = [this.prefix];

    if (paths) {
      for (const [pathName, pathDef] of Object.entries(this.paths)) {
        if (pathDef.type === 'static') {
          if (pathDef.required) {
            keyParts.push(pathDef.value!);
          }
          // If the static path is optional, skip it
        } else {
          const value = paths[pathName];
          if (value !== undefined && value !== null && value !== '') {
            keyParts.push(String(value));
          }
          // If the dynamic path is optional and not provided, skip it
        }
      }
    }

    return keyParts.join(this.separator);
  }

  /**
   * Parses a string key and retrieves the dynamic path values.
   * Ensures that the key does not contain duplicate prefixes.
   * @param key Key string from the database
   * @returns Object containing dynamic path values
   */
  public parseKey(key: string): Record<string, string> {
    const pathsDef = this.paths;
    const hasPaths = Object.keys(pathsDef).length > 0;

    if (!hasPaths) {
      if (key !== this.prefix) {
        throw new Error('Key does not match the schema paths');
      }
      return {};
    }

    const expectedPrefix = this.prefix + this.separator;
    if (!key.startsWith(expectedPrefix)) {
      throw new Error('Key does not match the schema paths');
    }

    const keyWithoutPrefix = key.slice(expectedPrefix.length);
    const keyParts = keyWithoutPrefix.split(this.separator);

    const pathEntries = Object.entries(pathsDef);
    const totalPathCount = pathEntries.length;
    const requiredPathCount = pathEntries.filter(
      ([, def]) => (def.type === 'dynamic' && def.required) || (def.type === 'static' && def.required)
    ).length;

    if (keyParts.length < requiredPathCount || keyParts.length > totalPathCount) {
      throw new Error('Key does not match the schema paths');
    }

    const parsedPaths: Record<string, string> = {};
    let keyIndex = 0;

    for (const [name, def] of pathEntries) {
      if (def.type === 'static') {
        if (keyIndex >= keyParts.length) {
          if (def.required) {
            throw new Error(`Missing required path: ${name}`);
          }
          continue;
        }

        const keyPart = keyParts[keyIndex];
        if (keyPart !== def.value) {
          throw new Error(`Static path mismatch for ${name}`);
        }
        keyIndex++;
      } else {
        if (keyIndex >= keyParts.length) {
          if (def.required) {
            throw new Error(`Missing required path: ${name}`);
          }
          continue;
        }

        const keyPart = keyParts[keyIndex];
        if (keyPart === undefined || keyPart === null || keyPart === '') {
          if (def.required) {
            throw new Error(`Missing required path: ${name}`);
          }
          continue;
        }

        parsedPaths[name] = keyPart;
        keyIndex++;
      }
    }

    // Ensure all required dynamic paths are present
    for (const [name, def] of pathEntries) {
      if (def.type === 'dynamic' && def.required) {
        const value = parsedPaths[name];
        if (value === undefined || value === null || value === '') {
          throw new Error(`Missing required path: ${name}`);
        }
      }
    }

    return parsedPaths;
  }

  public generatePrefixFromString(prefix: string): string {
    // Check if the prefix already starts with the schema's prefix
    if (prefix.startsWith(this.prefix + this.separator)) {
      return prefix;
    } else {
      return [this.prefix, prefix].join(this.separator);
    }
  }

  /**
   * Checks if the key ends with the given suffix by comparing the last segment.
   * @param key The full key string.
   * @param suffix The suffix to match.
   * @returns True if the last segment of the key matches the suffix.
   */
  public matchesSuffix(key: string, suffix: string): boolean {
    const keyParts = key.split(this.separator);
    const lastPart = keyParts[keyParts.length - 1];
    return lastPart === suffix;
  }
}
