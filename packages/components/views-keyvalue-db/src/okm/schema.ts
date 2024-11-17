interface PathDefinition {
  type: 'static' | 'dynamic'; // Type of the path
  required: boolean; // Whether the path is required
  value?: string; // Value for static paths
}

interface ValueDefinition {
  type: 'object' | 'string' | 'number' | 'boolean' | 'array'; // Type of the stored value
}

interface SchemaDefinition {
  prefix: string; // Key prefix
  separator: string; // Separator between key parts
  paths: Record<string, PathDefinition>; // Description of key paths
  values: ValueDefinition; // Description of the stored value
}

export class EntitySchema {
  prefix: string;
  separator: string;
  paths: Record<string, PathDefinition>;
  values: ValueDefinition;

  constructor(definition: SchemaDefinition) {
    this.prefix = definition.prefix;
    this.separator = definition.separator;
    this.paths = definition.paths;
    this.values = definition.values;
  }

  /**
   * Method to validate required paths
   * @param paths Dynamic path values
   */
  private validateRequiredPaths(paths: Record<string, any>) {
    for (const [key, definition] of Object.entries(this.paths)) {
      if (definition.required && (paths[key] === undefined || paths[key] === null)) {
        throw new Error(`Missing required path: ${key}`);
      }
    }
  }

  /**
   * Method to generate a key based on paths
   * @param paths Dynamic path values
   * @returns Generated key
   */
  public generateKey(paths: Record<string, any>): string {
    // Validate required paths before generating the key
    this.validateRequiredPaths(paths);

    const pathSegments = Object.entries(this.paths).map(([name, def]) => {
      if (def.type === 'static') {
        return def.value!;
      } else {
        return String(paths[name]);
      }
    });

    return [this.prefix, ...pathSegments].join(this.separator);
  }

  /**
   * Method to generate a prefix based on paths
   * @param paths Dynamic path values
   * @returns Generated prefix
   */
  public generatePrefix(paths?: Record<string, any>): string {
    const keyParts: string[] = [this.prefix];

    if (paths) {
      for (const [pathName, pathDef] of Object.entries(this.paths)) {
        if (pathDef.type === 'static') {
          keyParts.push(pathDef.value!);
        } else {
          const value = paths[pathName];
          if (value !== undefined && value !== null) {
            keyParts.push(String(value));
          } else {
            // Stop at the first undefined value
            break;
          }
        }
      }
    }

    return keyParts.join(this.separator);
  }

  /**
   * Method to parse a key and retrieve paths
   * @param key Key from the database
   * @returns Object containing path values
   */
  public parseKey(key: string): Record<string, any> {
    const keyWithoutPrefix = key.startsWith(this.prefix + this.separator)
      ? key.slice(this.prefix.length + this.separator.length)
      : key;
    const keyParts = keyWithoutPrefix.split(this.separator);
    const paths: Record<string, any> = {};

    const pathEntries = Object.entries(this.paths);
    if (keyParts.length !== pathEntries.length) {
      throw new Error('Key does not match the schema paths');
    }

    pathEntries.forEach(([name, def], index) => {
      const keyPart = keyParts[index];
      if (def.type === 'static') {
        if (keyPart !== def.value) {
          throw new Error(`Static path mismatch for ${name}`);
        }
      } else {
        paths[name] = keyPart;
      }
    });

    return paths;
  }
}
