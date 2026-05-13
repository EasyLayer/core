/**
 * Rate limiting configuration interface (unified across transports)
 */
export interface RateLimits {
  /** Maximum concurrent requests (default: 1) */
  maxConcurrentRequests?: number;
  /** Maximum batch size for parallel requests (default: 15) */
  maxBatchSize?: number;

  /**
   * Minimum time between requests in milliseconds (preferred).
   * Default: 0 — no artificial throttling.
   * The node enforces load limits via HTTP 429, handled as RateLimitError.
   * Set explicitly per provider: public RPC = 100-1000ms, own node = 0.
   */
  minTimeMsBetweenRequests?: number;

  /**
   * Legacy alias for `minTimeMsBetweenRequests`.
   * Ignored if `minTimeMsBetweenRequests` is provided.
   */
  requestDelayMs?: number;

  /** Optional token bucket settings */
  reservoir?: number;
  reservoirRefreshInterval?: number;
  reservoirRefreshAmount?: number;
}

// Bitcoin Network Configuration
export interface NetworkConfig {
  network: 'mainnet' | 'testnet' | 'regtest' | 'signet';
  nativeCurrencySymbol: string;
  nativeCurrencyDecimals: number;

  // P2P Protocol Configuration
  magicBytes?: number;
  defaultPort?: number;

  // Bitcoin-specific configurations
  hasSegWit: boolean;
  hasTaproot: boolean;
  hasRBF: boolean; // Replace-by-Fee
  hasCSV: boolean; // CheckSequenceVerify
  hasCLTV: boolean; // CheckLockTimeVerify

  // Block and transaction limits
  maxBlockSize: number;
  maxBlockWeight: number;

  // Mining difficulty adjustment
  difficultyAdjustmentInterval: number; // blocks
  targetBlockTime: number; // seconds
}
