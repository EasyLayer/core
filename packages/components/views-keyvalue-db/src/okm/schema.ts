export interface PathDefinition {
  type: 'static' | 'dynamic';
  value?: string;
}

export interface ValueDefinition {
  type: 'object' | 'string' | 'number' | 'boolean' | 'array';
  fields?: Record<string, ValueDefinition>;
  items?: ValueDefinition;
}

export interface SchemaDefinition {
  prefix: string;
  separator?: string;
  paths?: Record<string, PathDefinition>;
  data?: ValueDefinition;
}

export class EntitySchema {
  public prefix: string;
  public separator: string;
  public paths: Record<string, PathDefinition>;
  public data: ValueDefinition | null;

  constructor(definition: SchemaDefinition) {
    this.prefix = definition.prefix;
    this.separator = definition.separator ?? ':';
    this.paths = definition.paths ?? {};
    this.data = definition.data ?? null;
  }

  /**
   * @method toFullKeyString
   * @description
   * Converts a provided key (object or string) into a fully validated full key string.
   * - All static paths must match default if provided or be empty (then default applies).
   * - All dynamic paths must be provided (no undefined).
   * - Prefix ensured.
   */
  public toFullKeyString(key: Record<string, string> | string): string {
    let keyObj: Record<string, string>;
    if (typeof key === 'string') {
      const parsed = this.parseFullKeyString(key);
      keyObj = this.normalizeFullKeyObject(parsed);
    } else {
      keyObj = this.normalizeFullKeyObject(key);
    }
    return this.buildFullKeyString(keyObj);
  }

  /**
   * @method toPartialKeyString
   * @description
   * Converts a provided partial key (object or string) into a partial key string.
   * Partial keys:
   * - prefix + static defaults always
   * - dynamic paths only if provided
   * - static first, then dynamic to match test expectations
   */
  public toPartialKeyString(partialKey?: string | Record<string, string>): string {
    // We'll now strictly follow schema order:
    // If a dynamic path appears and we have no value for it, we throw an error.
    // If partialKey is undefined and dynamic is first, we fail.

    let obj: Record<string, string>;

    if (partialKey === undefined) {
      // No partial key given
      // We must create an object and see if we can fill
      obj = {};
    } else if (typeof partialKey === 'string') {
      obj = this.parsePartialKeyStringOrdered(partialKey);
    } else {
      // partialKey is an object
      obj = { ...partialKey };
    }

    return this.buildPartialKeyStringOrdered(obj);
  }

  /**
   * @method matchesSuffix
   * @description Checks if the provided full key string ends with the specified suffix.
   * If suffix is empty, return true (as per test expectation).
   */
  public matchesSuffix(key: string, suffix: string): boolean {
    if (!suffix) return true; // empty suffix means always match
    const keyParts = key.split(this.separator);
    const suffixParts = suffix.split(this.separator);
    const keySuffix = keyParts.slice(-suffixParts.length).join(this.separator);
    return keySuffix === suffix;
  }

  // -----------------------
  // Full key helpers
  // -----------------------
  private parseFullKeyString(key: string): Record<string, string> {
    const parts = key.split(this.separator);
    if (parts[0] !== this.prefix) {
      parts.unshift(this.prefix);
    }

    const result: Record<string, string> = {};
    let idx = 1;
    for (const [name, def] of Object.entries(this.paths)) {
      const seg = parts[idx] ?? undefined;
      if (def.type === 'static') {
        result[name] = seg ?? '';
      } else {
        result[name] = seg;
      }
      idx++;
    }

    return result;
  }

  private normalizeFullKeyObject(obj: Record<string, string>): Record<string, string> {
    const normalized: Record<string, string> = {};

    for (const [name, def] of Object.entries(this.paths)) {
      const val = obj[name];
      if (def.type === 'static') {
        // Check if static value incorrect
        if (val && val.trim() !== '' && def.value !== undefined && val !== def.value) {
          throw new Error(`Invalid value for static path '${name}'. Expected '${def.value}', got '${val}'`);
        }
        normalized[name] = val && val.trim() !== '' ? val : def.value ?? '';
      } else {
        // dynamic
        if (val === undefined || val === '') {
          throw new Error(`Missing required dynamic path '${name}' in full key.`);
        }
        normalized[name] = val;
      }
    }

    return normalized;
  }

  private buildFullKeyString(obj: Record<string, string>): string {
    const parts = [this.prefix];
    for (const [name, def] of Object.entries(this.paths)) {
      const val = obj[name];
      // After normalization, val should never be invalid
      parts.push(val ?? (def.type === 'static' ? def.value ?? '' : ''));
    }
    return parts.join(this.separator);
  }

  // -----------------------
  // Partial key helpers
  // -----------------------
  /**
   * @method parsePartialKeyStringOrdered
   * @description
   * Parses a partial key string in the exact schema order:
   * - Ensure prefix
   * - Assign paths in order: if static - use default; if dynamic - take next segment if available, else undefined
   */
  private parsePartialKeyStringOrdered(key: string): Record<string, string> {
    const parts = key.split(this.separator);
    if (parts[0] !== this.prefix) {
      parts.unshift(this.prefix);
    }

    const result: Record<string, string> = {};
    // Skip prefix at index 0
    let idx = 1;
    for (const [name, def] of Object.entries(this.paths)) {
      if (def.type === 'static') {
        // use default if none provided
        const seg = parts[idx] ?? undefined;
        // If segment present and not empty - use it, else use default
        result[name] = seg && seg.trim() !== '' ? seg : def.value ?? '';
        idx++;
      } else {
        // dynamic
        const seg = parts[idx] ?? undefined;
        if (seg && seg.trim() !== '') {
          result[name] = seg;
          idx++;
        } else {
          // no segment for dynamic?
          result[name] = undefined as any;
        }
      }
    }

    return result;
  }

  /**
   * @method buildPartialKeyStringOrdered
   * @description
   * Builds partial key string following schema order:
   * - If dynamic path is missing (undefined), throw error (new requirement)
   * - If static path missing, use default
   * If partialKey is totally undefined and dynamic first path can't be resolved -> error
   */
  private buildPartialKeyStringOrdered(obj: Record<string, string>): string {
    const parts = [this.prefix];

    for (const [name, def] of Object.entries(this.paths)) {
      const val = obj[name];
      if (def.type === 'static') {
        // If no value or empty, use default
        const finalVal = val && val.trim() !== '' ? val : def.value ?? '';
        parts.push(finalVal);
      } else {
        // dynamic
        if (val === undefined || val === '') {
          // Missing required dynamic in partial key scenario now also throws error as requested
          throw new Error(`Missing dynamic path '${name}' in partial key.`);
        }
        parts.push(val);
      }
    }

    return parts.join(this.separator);
  }
}
