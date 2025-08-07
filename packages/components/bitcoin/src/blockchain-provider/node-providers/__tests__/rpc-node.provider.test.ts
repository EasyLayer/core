import { RPCNodeProvider } from '../rpc-node.provider';
import type { NetworkConfig, UniversalBlock, UniversalTransaction, UniversalBlockStats } from '../interfaces';

// Mock network config for testing
const mockNetworkConfig: NetworkConfig = {
  network: 'mainnet',
  nativeCurrencySymbol: 'BTC',
  nativeCurrencyDecimals: 8,
  hasSegWit: true,
  hasTaproot: true,
  hasRBF: true,
  hasCSV: true,
  hasCLTV: true,
  maxBlockSize: 1000000,
  maxBlockWeight: 4000000,
  difficultyAdjustmentInterval: 2016,
  targetBlockTime: 600
};

describe('RPCNodeProvider Normalization Methods', () => {
  let provider: RPCNodeProvider;

  beforeEach(() => {
    provider = new RPCNodeProvider({
      baseUrl: 'http://localhost:8332',
      network: mockNetworkConfig,
      uniqName: 'test-provider',
      rateLimits: {}
    });
  });

  describe('normalizeRawBlock', () => {
    it('should normalize a complete raw block correctly', () => {
      const rawBlock = {
        hash: '00000000839a8e6886ab5951d76f411475428afc90947ee320161bbf18eb6048f',
        height: 1,
        strippedsize: 215,
        size: 215,
        weight: 860,
        version: 1,
        versionHex: '00000001',
        merkleroot: '0e3e2357e806b6cdb1f70b54c3a3a17b6714ee1f0e68bebb44a74b1efd512098',
        time: 1231469665,
        mediantime: 1231469665,
        nonce: 2573394689,
        bits: '1d00ffff',
        difficulty: '1',
        chainwork: '0000000000000000000000000000000000000000000000000000000200020002',
        previousblockhash: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f',
        nextblockhash: '000000006a625f06636b8bb6ac7b960a8d03705d1ace08b1a19da3fdcc99ddbd',
        tx: ['f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16'],
        nTx: 1,
        fee: 0,
        subsidy: 5000000000,
        miner: 'Unknown',
        pool: {
          poolName: 'Test Pool',
          url: 'https://testpool.com'
        }
      };

      const normalized: UniversalBlock = provider['normalizeRawBlock'](rawBlock);

      expect(normalized).toEqual({
        hash: '00000000839a8e6886ab5951d76f411475428afc90947ee320161bbf18eb6048f',
        height: 1,
        strippedsize: 215,
        size: 215,
        weight: 860,
        version: 1,
        versionHex: '00000001',
        merkleroot: '0e3e2357e806b6cdb1f70b54c3a3a17b6714ee1f0e68bebb44a74b1efd512098',
        time: 1231469665,
        mediantime: 1231469665,
        nonce: 2573394689,
        bits: '1d00ffff',
        difficulty: '1',
        chainwork: '0000000000000000000000000000000000000000000000000000000200020002',
        previousblockhash: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f',
        nextblockhash: '000000006a625f06636b8bb6ac7b960a8d03705d1ace08b1a19da3fdcc99ddbd',
        tx: ['f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16'],
        nTx: 1,
        fee: 0,
        subsidy: 5000000000,
        miner: 'Unknown',
        pool: {
          poolName: 'Test Pool',
          url: 'https://testpool.com'
        }
      });
    });

    it('should normalize a block with transaction objects', () => {
      const rawTransaction = {
        txid: 'f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16',
        hash: 'f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16',
        version: 1,
        size: 134,
        vsize: 134,
        weight: 536,
        locktime: 0,
        vin: [
          {
            coinbase: '04ffff001d0104',
            sequence: 4294967295
          }
        ],
        vout: [
          {
            value: 50,
            n: 0,
            scriptPubKey: {
              asm: '04678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5f OP_CHECKSIG',
              hex: '4104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac',
              type: 'pubkey'
            }
          }
        ]
      };

      const rawBlock = {
        hash: '00000000839a8e6886ab5951d76f411475428afc90947ee320161bbf18eb6048f',
        height: 1,
        strippedsize: 215,
        size: 215,
        weight: 860,
        version: 1,
        versionHex: '00000001',
        merkleroot: '0e3e2357e806b6cdb1f70b54c3a3a17b6714ee1f0e68bebb44a74b1efd512098',
        time: 1231469665,
        mediantime: 1231469665,
        nonce: 2573394689,
        bits: '1d00ffff',
        difficulty: '1',
        chainwork: '0000000000000000000000000000000000000000000000000000000200020002',
        tx: [rawTransaction],
        nTx: 1
      };

      const normalized = provider['normalizeRawBlock'](rawBlock);

      expect(normalized.tx).toHaveLength(1);
      expect(normalized.tx![0]).toEqual(expect.objectContaining({
        txid: 'f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16',
        version: 1,
        size: 134,
        vsize: 134,
        weight: 536
      }));
    });

    it('should handle blocks with minimal required fields', () => {
      const rawBlock = {
        hash: '00000000839a8e6886ab5951d76f411475428afc90947ee320161bbf18eb6048f',
        height: 1,
        strippedsize: 215,
        size: 215,
        weight: 860,
        version: 1,
        versionHex: '00000001',
        merkleroot: '0e3e2357e806b6cdb1f70b54c3a3a17b6714ee1f0e68bebb44a74b1efd512098',
        time: 1231469665,
        mediantime: 1231469665,
        nonce: 2573394689,
        bits: '1d00ffff',
        difficulty: '1',
        chainwork: '0000000000000000000000000000000000000000000000000000000200020002'
      };

      const normalized = provider['normalizeRawBlock'](rawBlock);

      expect(normalized.hash).toBe('00000000839a8e6886ab5951d76f411475428afc90947ee320161bbf18eb6048f');
      expect(normalized.height).toBe(1);
      expect(normalized.previousblockhash).toBeUndefined();
      expect(normalized.nextblockhash).toBeUndefined();
      expect(normalized.tx).toBeUndefined();
      expect(normalized.fee).toBeUndefined();
    });
  });

  describe('normalizeRawTransaction', () => {
    it('should normalize a complete raw transaction correctly', () => {
      const rawTx = {
        txid: 'f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16',
        hash: 'f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16',
        version: 1,
        size: 134,
        vsize: 134,
        weight: 536,
        locktime: 0,
        vin: [
          {
            coinbase: '04ffff001d0104',
            sequence: 4294967295
          }
        ],
        vout: [
          {
            value: 50,
            n: 0,
            scriptPubKey: {
              asm: '04678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5f OP_CHECKSIG',
              hex: '4104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac',
              type: 'pubkey'
            }
          }
        ],
        blockhash: '00000000839a8e6886ab5951d76f411475428afc90947ee320161bbf18eb6048f',
        time: 1231469665,
        blocktime: 1231469665,
        fee: 0,
        wtxid: 'f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16',
        depends: [],
        spentby: [],
        'bip125-replaceable': false
      };

      const normalized: UniversalTransaction = provider['normalizeRawTransaction'](rawTx);

      expect(normalized).toEqual({
        txid: 'f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16',
        hash: 'f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16',
        version: 1,
        size: 134,
        vsize: 134,
        weight: 536,
        locktime: 0,
        vin: [
          {
            txid: undefined,
            vout: undefined,
            scriptSig: undefined,
            sequence: 4294967295,
            coinbase: '04ffff001d0104',
            txinwitness: undefined
          }
        ],
        vout: [
          {
            value: 50,
            n: 0,
            scriptPubKey: {
              asm: '04678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5f OP_CHECKSIG',
              hex: '4104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac',
              type: 'pubkey'
            }
          }
        ],
        blockhash: '00000000839a8e6886ab5951d76f411475428afc90947ee320161bbf18eb6048f',
        time: 1231469665,
        blocktime: 1231469665,
        fee: 0,
        wtxid: 'f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16',
        depends: [],
        spentby: [],
        bip125_replaceable: false
      });
    });

    it('should normalize a SegWit transaction with witness data', () => {
      const rawTx = {
        txid: '2f4f6a048343f2cdd743d52063b6ce6ea378e32d8e17c19c3f8e0a3b4c5e2ac6',
        hash: '2f4f6a048343f2cdd743d52063b6ce6ea378e32d8e17c19c3f8e0a3b4c5e2ac6',
        version: 2,
        size: 226,
        vsize: 144,
        weight: 574,
        locktime: 0,
        vin: [
          {
            txid: 'b21a9f6e4c84dc5e4ca2d6e1a7c8b9d2f1e3a8c4d5f6e7a9b8c7d6e5f4a3b2c1',
            vout: 0,
            scriptSig: {
              asm: '',
              hex: ''
            },
            sequence: 4294967295,
            txinwitness: [
              '3045022100f3581e1972ae8ac7c7367a7a253bc1135223adb9a468bb3a59233f45bc578380022059af01ca17d00e41928954ac27a774b1de63509db7a8a5cc2ac0c8e4d5da5b87',
              '0242b0b6ccc6d4b3e8e7c8a1d2f4e5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2'
            ]
          }
        ],
        vout: [
          {
            value: 0.5,
            n: 0,
            scriptPubKey: {
              asm: 'OP_DUP OP_HASH160 76a914000000000000000000000000000000000000000088ac',
              hex: '76a914000000000000000000000000000000000000000088ac',
              type: 'pubkeyhash',
              addresses: ['1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa']
            }
          }
        ]
      };

      const normalized = provider['normalizeRawTransaction'](rawTx);

      expect(normalized.vin[0]!.txinwitness).toEqual([
        '3045022100f3581e1972ae8ac7c7367a7a253bc1135223adb9a468bb3a59233f45bc578380022059af01ca17d00e41928954ac27a774b1de63509db7a8a5cc2ac0c8e4d5da5b87',
        '0242b0b6ccc6d4b3e8e7c8a1d2f4e5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2'
      ]);
      expect(normalized.size).toBe(226);
      expect(normalized.vsize).toBe(144);
      expect(normalized.weight).toBe(574);
    });

    it('should handle transactions with empty or missing arrays', () => {
      const rawTx = {
        txid: 'test-txid',
        hash: 'test-hash',
        version: 1,
        size: 100,
        vsize: 100,
        weight: 400,
        locktime: 0
        // Missing vin and vout
      };

      const normalized = provider['normalizeRawTransaction'](rawTx);

      expect(normalized.vin).toEqual([]);
      expect(normalized.vout).toEqual([]);
      expect(normalized.txid).toBe('test-txid');
      expect(normalized.hash).toBe('test-hash');
    });
  });

  describe('normalizeRawBlockStats', () => {
    it('should normalize complete raw block stats correctly', () => {
      const rawStats = {
        blockhash: '00000000839a8e6886ab5951d76f411475428afc90947ee320161bbf18eb6048f',
        height: 1,
        total_size: 215,
        total_weight: 860,
        total_fee: 0,
        fee_rate_percentiles: [1, 2, 3, 4, 5],
        subsidy: 5000000000,
        total_out: 5000000000,
        utxo_increase: 1,
        utxo_size_inc: 117,
        ins: 1,
        outs: 1,
        txs: 1,
        minfee: 0,
        maxfee: 0,
        medianfee: 0,
        avgfee: 0,
        minfeerate: 0,
        maxfeerate: 0,
        medianfeerate: 0,
        avgfeerate: 0,
        mintxsize: 134,
        maxtxsize: 134,
        mediantxsize: 134,
        avgtxsize: 134,
        total_stripped_size: 215,
        witness_txs: 0
      };

      const normalized: UniversalBlockStats = provider['normalizeRawBlockStats'](rawStats);

      expect(normalized).toEqual({
        blockhash: '00000000839a8e6886ab5951d76f411475428afc90947ee320161bbf18eb6048f',
        height: 1,
        total_size: 215,
        total_weight: 860,
        total_fee: 0,
        fee_rate_percentiles: [1, 2, 3, 4, 5],
        subsidy: 5000000000,
        total_out: 5000000000,
        utxo_increase: 1,
        utxo_size_inc: 117,
        ins: 1,
        outs: 1,
        txs: 1,
        minfee: 0,
        maxfee: 0,
        medianfee: 0,
        avgfee: 0,
        minfeerate: 0,
        maxfeerate: 0,
        medianfeerate: 0,
        avgfeerate: 0,
        mintxsize: 134,
        maxtxsize: 134,
        mediantxsize: 134,
        avgtxsize: 134,
        total_stripped_size: 215,
        witness_txs: 0
      });
    });

    it('should normalize minimal block stats correctly', () => {
      const rawStats = {
        blockhash: '00000000839a8e6886ab5951d76f411475428afc90947ee320161bbf18eb6048f',
        height: 1,
        total_size: 215
      };

      const normalized = provider['normalizeRawBlockStats'](rawStats);

      expect(normalized.blockhash).toBe('00000000839a8e6886ab5951d76f411475428afc90947ee320161bbf18eb6048f');
      expect(normalized.height).toBe(1);
      expect(normalized.total_size).toBe(215);
      expect(normalized.total_weight).toBeUndefined();
      expect(normalized.fee_rate_percentiles).toBeUndefined();
    });

    it('should handle block stats with undefined values', () => {
      const rawStats = {
        blockhash: '00000000839a8e6886ab5951d76f411475428afc90947ee320161bbf18eb6048f',
        height: 1,
        total_size: 215,
        total_weight: undefined,
        total_fee: null,
        fee_rate_percentiles: undefined
      };

      const normalized = provider['normalizeRawBlockStats'](rawStats);

      expect(normalized.blockhash).toBe('00000000839a8e6886ab5951d76f411475428afc90947ee320161bbf18eb6048f');
      expect(normalized.height).toBe(1);
      expect(normalized.total_size).toBe(215);
      expect(normalized.total_weight).toBeUndefined();
      expect(normalized.total_fee).toBeNull();
      expect(normalized.fee_rate_percentiles).toBeUndefined();
    });
  });

  describe('Edge Cases and Data Integrity', () => {
    it('should preserve all data types correctly', () => {
      const rawBlock = {
        hash: 'test-hash',
        height: 123456,
        strippedsize: 1000,
        size: 1200,
        weight: 4000,
        version: 2,
        versionHex: '20000000',
        merkleroot: 'test-merkleroot',
        time: 1609459200,
        mediantime: 1609459100,
        nonce: 123456789,
        bits: '1a00ffff',
        difficulty: '16777216',
        chainwork: '000000000000000000000000000000000000000000000001234567890abcdef',
        nTx: 2500
      };

      const normalized = provider['normalizeRawBlock'](rawBlock);

      // Check that all numeric values are preserved correctly
      expect(typeof normalized.height).toBe('number');
      expect(typeof normalized.strippedsize).toBe('number');
      expect(typeof normalized.size).toBe('number');
      expect(typeof normalized.weight).toBe('number');
      expect(typeof normalized.version).toBe('number');
      expect(typeof normalized.time).toBe('number');
      expect(typeof normalized.mediantime).toBe('number');
      expect(typeof normalized.nonce).toBe('number');
      expect(typeof normalized.nTx).toBe('number');

      // Check string values
      expect(typeof normalized.hash).toBe('string');
      expect(typeof normalized.versionHex).toBe('string');
      expect(typeof normalized.difficulty).toBe('string');
    });

    it('should handle transaction arrays with mixed string and object types', () => {
      const rawBlock = {
        hash: 'test-hash',
        height: 1,
        strippedsize: 500,
        size: 500,
        weight: 2000,
        version: 1,
        versionHex: '00000001',
        merkleroot: 'test-merkleroot',
        time: 1609459200,
        mediantime: 1609459100,
        nonce: 123456789,
        bits: '1a00ffff',
        difficulty: '1',
        chainwork: '000000000000000000000000000000000000000000000000000000000000001',
        tx: [
          'txhash1',
          'txhash2',
          {
            txid: 'full-tx-object',
            hash: 'full-tx-hash',
            version: 1,
            size: 100,
            vsize: 100,
            weight: 400,
            locktime: 0,
            vin: [],
            vout: []
          }
        ],
        nTx: 3
      };

      const normalized = provider['normalizeRawBlock'](rawBlock);

      expect(normalized.tx).toHaveLength(3);
      expect(normalized.tx![0]).toBe('txhash1');
      expect(normalized.tx![1]).toBe('txhash2');
      expect(normalized.tx![2]).toEqual(expect.objectContaining({
        txid: 'full-tx-object',
        hash: 'full-tx-hash'
      }));
    });
  });
});