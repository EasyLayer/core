// // ==================== BASE INTERFACES ====================

// /**
//  * Base Ethereum block header (Genesis/Frontier era)
//  */
// interface BaseBlockHeader {
//     parentHash: string;         // 32 bytes
//     sha3Uncles: string;        // 32 bytes (ommersHash)
//     miner: string;             // 20 bytes (beneficiary/coinbase)
//     stateRoot: string;         // 32 bytes
//     transactionsRoot: string;  // 32 bytes
//     receiptsRoot: string;      // 32 bytes
//     logsBloom: string;         // 256 bytes
//     difficulty: string | number; // variable length
//     blockNumber: string | number; // variable length
//     gasLimit: string | number;    // variable length
//     gasUsed: string | number;     // variable length
//     timestamp: string | number;   // variable length
//     extraData: string;         // variable length (max 32 bytes)
//     mixHash: string;           // 32 bytes
//     nonce: string;             // 8 bytes
// }

// /**
//  * London/EIP-1559 Block Header (August 2021)
//  * Adds baseFeePerGas
//  */
// interface LondonBlockHeader extends BaseBlockHeader {
//     baseFeePerGas: string | number; // variable length
// }

// /**
//  * Shanghai/EIP-4895 Block Header (March 2023)
//  * Adds withdrawalsRoot for staking withdrawals
//  */
// interface ShanghaiBlockHeader extends LondonBlockHeader {
//     withdrawalsRoot: string; // 32 bytes
// }

// /**
//  * Cancun/EIP-4844 Block Header (March 2024)
//  * Adds blob gas fields and parent beacon block root
//  */
// interface CancunBlockHeader extends ShanghaiBlockHeader {
//     blobGasUsed: string | number;      // variable length
//     excessBlobGas: string | number;    // variable length
//     parentBeaconBlockRoot: string;     // 32 bytes
// }

// // ==================== TRANSACTION INTERFACES ====================

// /**
//  * Legacy Transaction (Pre-EIP-1559)
//  */
// interface LegacyTransaction {
//     nonce: string | number;
//     gasPrice: string | number;
//     gas: string | number;
//     to: string | null;
//     value: string | number;
//     input: string; // data field
//     v: string | number;
//     r: string;
//     s: string;
// }

// /**
//  * EIP-2930 Access List Transaction
//  */
// interface AccessListTransaction extends LegacyTransaction {
//     chainId: string | number;
//     accessList: Array<{
//         address: string;
//         storageKeys: string[];
//     }>;
// }

// /**
//  * EIP-1559 Dynamic Fee Transaction
//  */
// interface DynamicFeeTransaction {
//     chainId: string | number;
//     nonce: string | number;
//     maxPriorityFeePerGas: string | number;
//     maxFeePerGas: string | number;
//     gas: string | number;
//     to: string | null;
//     value: string | number;
//     input: string;
//     accessList: Array<{
//         address: string;
//         storageKeys: string[];
//     }>;
//     v: string | number;
//     r: string;
//     s: string;
// }

// /**
//  * EIP-4844 Blob Transaction
//  */
// interface BlobTransaction extends DynamicFeeTransaction {
//     maxFeePerBlobGas: string | number;
//     blobVersionedHashes: string[];
// }

// /**
//  * Union type for all transaction types
//  */
// type Transaction = LegacyTransaction | AccessListTransaction | DynamicFeeTransaction | BlobTransaction;

// // ==================== WITHDRAWAL INTERFACE ====================

// /**
//  * EIP-4895 Withdrawal
//  */
// interface Withdrawal {
//     index: string | number;
//     validatorIndex: string | number;
//     address: string;
//     amount: string | number; // in Gwei
// }

// // ==================== COMPLETE BLOCK INTERFACES ====================

// /**
//  * Genesis/Frontier Block (2015)
//  */
// interface GenesisBlock {
//     header: BaseBlockHeader;
//     transactions: Transaction[];
//     uncles: BaseBlockHeader[];
// }

// /**
//  * London Block (EIP-1559 - August 2021)
//  */
// interface LondonBlock {
//     header: LondonBlockHeader;
//     transactions: Transaction[];
//     uncles: BaseBlockHeader[];
// }

// /**
//  * Shanghai Block (EIP-4895 - March 2023)
//  */
// interface ShanghaiBlock {
//     header: ShanghaiBlockHeader;
//     transactions: Transaction[];
//     uncles: BaseBlockHeader[];
//     withdrawals: Withdrawal[];
// }

// /**
//  * Cancun Block (EIP-4844 - March 2024)
//  */
// interface CancunBlock {
//     header: CancunBlockHeader;
//     transactions: Transaction[];
//     uncles: BaseBlockHeader[];
//     withdrawals: Withdrawal[];
// }

// // ==================== RLP ENCODING HELPERS ====================

// /**
//  * RLP encoding order for different block types
//  */
// class BlockRLPEncoder {

// /**
//  * Encodes Genesis/Frontier block header for RLP
//  */
// static encodeGenesisHeader(header: BaseBlockHeader): any[] {
//     return [
//         header.parentHash,
//         header.sha3Uncles,
//         header.miner,
//         header.stateRoot,
//         header.transactionsRoot,
//         header.receiptsRoot,
//         header.logsBloom,
//         this.toHex(header.difficulty),
//         this.toHex(header.blockNumber),
//         this.toHex(header.gasLimit),
//         this.toHex(header.gasUsed),
//         this.toHex(header.timestamp),
//         header.extraData,
//         header.mixHash,
//         header.nonce
//     ];
// }

// /**
//  * Encodes London block header for RLP (with baseFeePerGas)
//  */
// static encodeLondonHeader(header: LondonBlockHeader): any[] {
//     return [
//         ...this.encodeGenesisHeader(header),
//         this.toHex(header.baseFeePerGas)
//     ];
// }

// /**
//  * Encodes Shanghai block header for RLP (with withdrawalsRoot)
//  */
// static encodeShanghaiHeader(header: ShanghaiBlockHeader): any[] {
//     return [
//         ...this.encodeLondonHeader(header),
//         header.withdrawalsRoot
//     ];
// }

// /**
//  * Encodes Cancun block header for RLP (with blob fields)
//  */
// static encodeCancunHeader(header: CancunBlockHeader): any[] {
//     return [
//         ...this.encodeShanghaiHeader(header),
//         this.toHex(header.blobGasUsed),
//         this.toHex(header.excessBlobGas),
//         header.parentBeaconBlockRoot
//     ];
// }

// /**
//  * Encodes legacy transaction for RLP
//  */
// static encodeLegacyTransaction(tx: LegacyTransaction): any[] {
//     return [
//         this.toHex(tx.nonce),
//         this.toHex(tx.gasPrice),
//         this.toHex(tx.gas),
//         tx.to || '0x',
//         this.toHex(tx.value),
//         tx.input,
//         this.toHex(tx.v),
//         tx.r,
//         tx.s
//     ];
// }

// /**
//  * Encodes EIP-2930 access list transaction for RLP
//  */
// static encodeAccessListTransaction(tx: AccessListTransaction): any[] {
//     const accessList = tx.accessList.map(entry => [
//         entry.address,
//         entry.storageKeys
//     ]);

//     return [
//         0x01, // Transaction type
//         [
//             this.toHex(tx.chainId),
//             this.toHex(tx.nonce),
//             this.toHex(tx.gasPrice),
//             this.toHex(tx.gas),
//             tx.to || '0x',
//             this.toHex(tx.value),
//             tx.input,
//             accessList,
//             this.toHex(tx.v),
//             tx.r,
//             tx.s
//         ]
//     ];
// }

// /**
//  * Encodes EIP-1559 dynamic fee transaction for RLP
//  */
// static encodeDynamicFeeTransaction(tx: DynamicFeeTransaction): any[] {
//     const accessList = tx.accessList.map(entry => [
//     entry.address,
//     entry.storageKeys
//     ]);

//     return [
//     0x02, // Transaction type
//     [
//         this.toHex(tx.chainId),
//         this.toHex(tx.nonce),
//         this.toHex(tx.maxPriorityFeePerGas),
//         this.toHex(tx.maxFeePerGas),
//         this.toHex(tx.gas),
//         tx.to || '0x',
//         this.toHex(tx.value),
//         tx.input,
//         accessList,
//         this.toHex(tx.v),
//         tx.r,
//         tx.s
//     ]
//     ];
// }

// /**
//  * Encodes EIP-4844 blob transaction for RLP
//  */
// static encodeBlobTransaction(tx: BlobTransaction): any[] {
//     const accessList = tx.accessList.map(entry => [
//     entry.address,
//     entry.storageKeys
//     ]);

//     return [
//     0x03, // Transaction type
//     [
//         this.toHex(tx.chainId),
//         this.toHex(tx.nonce),
//         this.toHex(tx.maxPriorityFeePerGas),
//         this.toHex(tx.maxFeePerGas),
//         this.toHex(tx.gas),
//         tx.to || '0x',
//         this.toHex(tx.value),
//         tx.input,
//         accessList,
//         this.toHex(tx.maxFeePerBlobGas),
//         tx.blobVersionedHashes,
//         this.toHex(tx.v),
//         tx.r,
//         tx.s
//     ]
//     ];
// }

// /**
//  * Encodes withdrawal for RLP
//  */
// static encodeWithdrawal(withdrawal: Withdrawal): any[] {
//     return [
//     this.toHex(withdrawal.index),
//     this.toHex(withdrawal.validatorIndex),
//     withdrawal.address,
//     this.toHex(withdrawal.amount)
//     ];
// }

// /**
//  * Encodes complete block for RLP based on block type
//  */
// static encodeBlock(block: GenesisBlock | LondonBlock | ShanghaiBlock | CancunBlock): any[] {
//     let headerArray: any[];

//     // Determine block type and encode header accordingly
//     if ('parentBeaconBlockRoot' in block.header) {
//     // Cancun block
//     headerArray = this.encodeCancunHeader(block.header as CancunBlockHeader);
//     } else if ('withdrawalsRoot' in block.header) {
//     // Shanghai block
//     headerArray = this.encodeShanghaiHeader(block.header as ShanghaiBlockHeader);
//     } else if ('baseFeePerGas' in block.header) {
//     // London block
//     headerArray = this.encodeLondonHeader(block.header as LondonBlockHeader);
//     } else {
//     // Genesis/Frontier block
//     headerArray = this.encodeGenesisHeader(block.header);
//     }

//     // Encode transactions
//     const transactionsArray = block.transactions.map(tx => {
//     if ('maxFeePerBlobGas' in tx) {
//         return this.encodeBlobTransaction(tx as BlobTransaction);
//     } else if ('maxFeePerGas' in tx) {
//         return this.encodeDynamicFeeTransaction(tx as DynamicFeeTransaction);
//     } else if ('accessList' in tx) {
//         return this.encodeAccessListTransaction(tx as AccessListTransaction);
//     } else {
//         return this.encodeLegacyTransaction(tx as LegacyTransaction);
//     }
//     });

//     // Encode uncles
//     const unclesArray = block.uncles.map(uncle => this.encodeGenesisHeader(uncle));

//     // Base block structure
//     const blockArray = [headerArray, transactionsArray, unclesArray];

//     // Add withdrawals for Shanghai+ blocks
//     if ('withdrawals' in block) {
//     const withdrawalsArray = block.withdrawals.map(w => this.encodeWithdrawal(w));
//     blockArray.push(withdrawalsArray);
//     }

//     return blockArray;
// }

// /**
//  * Helper method to ensure proper hex formatting
//  */
// private static toHex(value: string | number | bigint): string {
//     if (typeof value === 'string' && value.startsWith('0x')) {
//     return value;
//     }
//     if (typeof value === 'bigint') {
//     return '0x' + value.toString(16);
//     }
//     if (typeof value === 'number') {
//     return '0x' + value.toString(16);
//     }
//     return '0x' + value.toString();
// }
// }

// // ==================== BLOCK TYPE DETECTION ====================

// /**
//  * Utility to detect block type and return appropriate encoder
//  */
// class BlockTypeDetector {

//     static detectBlockType(header: any): 'genesis' | 'london' | 'shanghai' | 'cancun' {
//         if (header.parentBeaconBlockRoot !== undefined) {
//         return 'cancun';
//         }
//         if (header.withdrawalsRoot !== undefined) {
//         return 'shanghai';
//         }
//         if (header.baseFeePerGas !== undefined) {
//         return 'london';
//         }
//         return 'genesis';
//     }

//     static getBlockNumberRanges() {
//         return {
//         genesis: { start: 0, end: 12964999 },      // До London
//         london: { start: 12965000, end: 17034869 }, // EIP-1559
//         shanghai: { start: 17034870, end: 19426586 }, // EIP-4895
//         cancun: { start: 19426587, end: null }      // EIP-4844
//         };
//     }
// }

// // ==================== EXPORT TYPES ====================

// export type {
//     BaseBlockHeader,
//     LondonBlockHeader,
//     ShanghaiBlockHeader,
//     CancunBlockHeader,
//     LegacyTransaction,
//     AccessListTransaction,
//     DynamicFeeTransaction,
//     BlobTransaction,
//     Transaction,
//     Withdrawal,
//     GenesisBlock,
//     LondonBlock,
//     ShanghaiBlock,
//     CancunBlock,
//     BlockRLPEncoder,
//     BlockTypeDetector
// };
