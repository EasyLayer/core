/**
 * Validates that aggregateId is safe for direct use as a SQL table name.
 *
 * Rules:
 * - Must start with a letter [a-zA-Z]
 * - May contain letters, digits, underscores, hyphens [a-zA-Z0-9_-]
 * - Maximum 60 characters (leaves room for index/constraint name suffixes)
 *
 * This is intentionally strict: aggregateIds are defined by developers,
 * not by end users, so there is no reason to accept exotic characters.
 */
export function validateAggregateId(id: string): void {
  if (!id || id.length === 0) {
    throw new Error('aggregateId must not be empty');
  }
  if (id.length > 60) {
    throw new Error(`aggregateId "${id}" exceeds maximum length of 60 characters (got ${id.length})`);
  }
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(id)) {
    throw new Error(
      `aggregateId "${id}" contains invalid characters. ` +
        `Only [a-zA-Z][a-zA-Z0-9_-]* is allowed (must start with a letter).`
    );
  }
}
