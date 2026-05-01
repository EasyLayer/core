/**
 * EVM JSON-RPC returns most large numeric values as hex quantities.
 * Public normalized models expose large values (wei, fees, difficulty) as decimal strings
 * to avoid precision loss and to keep consumer-facing models easy to use.
 */
export function quantityToBigInt(value: unknown, fallback = 0n): bigint {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? BigInt(Math.trunc(value)) : fallback;
  if (typeof value !== 'string') return fallback;

  try {
    return value.startsWith('0x') || value.startsWith('0X') ? BigInt(value) : BigInt(value);
  } catch {
    return fallback;
  }
}

export function quantityToNumber(value: unknown, fallback = 0): number {
  const n = Number(quantityToBigInt(value, BigInt(fallback)));
  return Number.isFinite(n) ? n : fallback;
}

export function quantityToDecimalString(value: unknown, fallback = '0'): string {
  try {
    return quantityToBigInt(value, BigInt(fallback)).toString(10);
  } catch {
    return fallback;
  }
}

export function optionalQuantityToNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  return quantityToNumber(value);
}

export function optionalQuantityToDecimalString(value: unknown): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  return quantityToDecimalString(value);
}

export function normalizeHex(value: unknown, fallback = '0x'): string {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  return value.startsWith('0x') || value.startsWith('0X')
    ? `0x${value.slice(2).toLowerCase()}`
    : `0x${value.toLowerCase()}`;
}

export function normalizeAddress(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase() : '';
}
