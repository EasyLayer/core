interface PathDefinition {
  type: 'static' | 'dynamic'; // Type of the path
  required: boolean; // Whether the path is required
  value?: string; // Value for static paths
}

interface ValueDefinition {
  type: 'object' | 'string' | 'number' | 'boolean' | 'array'; // Type of the stored value
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
   * Method to validate required dynamic paths
   * @param paths Dynamic path values
   */
  private validateRequiredPaths(paths: Record<string, any>) {
    for (const [key, definition] of Object.entries(this.paths)) {
      if (definition.type === 'dynamic' && definition.required && (paths[key] === undefined || paths[key] === null)) {
        throw new Error(`Missing required dynamic path: ${key}`);
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

    const pathSegments = Object.entries(this.paths).reduce<string[]>((segments, [name, def]) => {
      if (def.type === 'static') {
        segments.push(def.value!);
      } else {
        if (paths[name] !== undefined && paths[name] !== null) {
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
   * Method to generate a prefix based on paths
   * @param paths Dynamic path values
   * @returns Generated prefix
   */
  public generatePrefix(paths?: Record<string, any>): string {
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
          if (value !== undefined && value !== null) {
            keyParts.push(String(value));
          }
          // If the dynamic path is optional and not provided, skip it
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
    // Retrieve the path definitions from the schema
    const pathsDef = this.paths;

    // Determine if the schema has any defined paths
    const hasPaths = Object.keys(pathsDef).length > 0;

    // If there are no paths defined in the schema
    if (!hasPaths) {
      // The key must exactly match the prefix
      if (key !== this.prefix) {
        throw new Error('Key does not match the schema paths');
      }
      // Return an empty object as there are no paths to parse
      return {};
    }

    // Construct the expected prefix by combining the schema prefix and separator
    const expectedPrefix = this.prefix + this.separator;

    // Check if the key starts with the expected prefix
    if (!key.startsWith(expectedPrefix)) {
      throw new Error('Key does not match the schema paths');
    }

    // Remove the prefix from the key to isolate the path segments
    const keyWithoutPrefix = key.slice(expectedPrefix.length);

    // Split the remaining key into individual segments based on the separator
    const keyParts = keyWithoutPrefix.split(this.separator);

    // Convert the path definitions into an array of [pathName, pathDefinition] pairs
    const pathEntries = Object.entries(pathsDef);

    // Total number of paths defined in the schema
    const totalPathCount = pathEntries.length;

    // Number of required paths (both static and dynamic)
    /* eslint-disable @typescript-eslint/no-unused-vars */
    const requiredPathCount = pathEntries.filter(
      ([_, def]) => (def.type === 'dynamic' && def.required) || (def.type === 'static' && def.required)
    ).length;
    /* eslint-disable @typescript-eslint/no-unused-vars */

    // Check that the number of key segments is within the acceptable range
    // It should be at least the number of required paths and no more than the total paths
    if (keyParts.length < requiredPathCount || keyParts.length > totalPathCount) {
      throw new Error('Key does not match the schema paths');
    }

    // Object to store the parsed dynamic path values
    const parsedPaths: Record<string, any> = {};

    // Index to keep track of the current position in keyParts
    let keyIndex = 0;

    // Iterate over each path definition
    for (const [name, def] of pathEntries) {
      if (def.type === 'static') {
        // If the current path is static

        // Ensure there are enough key segments to match the path definitions
        if (keyIndex >= keyParts.length) {
          if (def.required) {
            // If the static path is required but missing, throw an error
            throw new Error(`Missing required path: ${name}`);
          }
          // If the static path is not required, skip to the next path
          continue;
        }

        // Retrieve the corresponding segment from the key
        const keyPart = keyParts[keyIndex];

        // Check if the static path segment matches the expected value
        if (keyPart !== def.value) {
          throw new Error(`Static path mismatch for ${name}`);
        }

        // Move to the next segment
        keyIndex++;
      } else {
        // dynamic
        // If the current path is dynamic

        // Ensure there are enough key segments to match the path definitions
        if (keyIndex >= keyParts.length) {
          if (def.required) {
            // If the dynamic path is required but missing, throw an error
            throw new Error(`Missing required path: ${name}`);
          }
          // If the dynamic path is not required, skip to the next path
          continue;
        }

        // Retrieve the corresponding segment from the key
        const keyPart = keyParts[keyIndex];

        // Check if the dynamic path segment has a valid value
        if (keyPart === undefined || keyPart === null || keyPart === '') {
          if (def.required) {
            // If the dynamic path is required but the value is invalid, throw an error
            throw new Error(`Missing required path: ${name}`);
          }
          // If the dynamic path is not required, skip to the next path
          continue;
        }

        // Assign the dynamic path value to the parsedPaths object
        parsedPaths[name] = keyPart;

        // Move to the next segment
        keyIndex++;
      }
    }

    // Additional check to ensure all required dynamic paths have been parsed correctly
    for (const [name, def] of pathEntries) {
      if (def.type === 'dynamic' && def.required) {
        const value = parsedPaths[name];
        if (value === undefined || value === null || value === '') {
          throw new Error(`Missing required path: ${name}`);
        }
      }
    }

    // Return the object containing the parsed dynamic path values
    return parsedPaths;
  }
}
