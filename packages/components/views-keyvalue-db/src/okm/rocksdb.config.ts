export interface IRocksDBOptions {
  create_if_missing?: boolean;
  write_buffer_size?: number;
  max_write_buffer_number?: number;
  min_write_buffer_number_to_merge?: number;
  block_size?: number;
  cache_size?: number;
  compression?: string;
  max_background_compactions?: number;
  level_compaction_dynamic_level_bytes?: boolean;
  bloom_filter?: boolean;
  bloom_bits_per_key?: number;
  read_ahead_size?: number;
  max_background_flushes?: number;
}

export const DEFAULT_ROCKSDB_OPTIONS: IRocksDBOptions = {
  create_if_missing: true,
  write_buffer_size: 64 * 1024 * 1024, // 64 MB
  max_write_buffer_number: 3,
  min_write_buffer_number_to_merge: 2,
  block_size: 64 * 1024, // 64 KB
  cache_size: 256 * 1024 * 1024, // 256 MB
  compression: 'snappy', // Compression algorithm
  max_background_compactions: 4,
  level_compaction_dynamic_level_bytes: true,
  bloom_filter: true,
  bloom_bits_per_key: 10,
  read_ahead_size: 4 * 1024 * 1024, // 4 MB
  max_background_flushes: 2,
};

export const mergeRocksDBOptions = (userOptions: Partial<IRocksDBOptions>): IRocksDBOptions => {
  return { ...DEFAULT_ROCKSDB_OPTIONS, ...userOptions };
};
