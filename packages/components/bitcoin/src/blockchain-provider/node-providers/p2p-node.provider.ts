// import type { NetworkConfig as BitcoreNetworkConfig } from 'bitcore-p2p';
// import { Pool, Peer, Messages } from 'bitcore-p2p';
// import * as zmq from 'zeromq';
// import type { BaseNodeProviderOptions } from './base-node-provider';
// import { BaseNodeProvider } from './base-node-provider';
// import type {
//   NetworkConfig,
//   UniversalBlock,
//   UniversalTransaction,
//   UniversalBlockStats,
//   UniversalMempoolTransaction,
//   UniversalMempoolInfo,
// } from './interfaces';
// import { NodeProviderTypes } from './interfaces';
// import { HexTransformer } from './hex-transformer';
// import { RateLimiter } from './rate-limiter';

// export interface P2PNodeProviderOptions extends BaseNodeProviderOptions {
//   // P2P Connection settings - support multiple peers
//   peers: Array<{
//     host: string;
//     port: number;
//   }>;
//   network: NetworkConfig;

//   // ZMQ settings (optional - if not provided, will use P2P for new blocks too)
//   zmqEndpoint?: string;

//   // Connection settings
//   maxPeers?: number;
//   connectionTimeout?: number;

//   // Batch settings
//   maxBatchSize?: number;
// }

// export const createP2PNodeProvider = (options: P2PNodeProviderOptions): P2PNodeProvider => {
//   return new P2PNodeProvider(options);
// };

// export class P2PNodeProvider extends BaseNodeProvider<P2PNodeProviderOptions> {
//   readonly type: NodeProviderTypes = NodeProviderTypes.P2P;

//   private pool: Pool;
//   private activePeer: Peer | null = null;
//   private network: NetworkConfig;
//   private rateLimiter: RateLimiter;
//   private peers: Array<{ host: string; port: number }>;

//   // ZMQ settings
//   private zmqEndpoint?: string;
//   private zmqSocket?: zmq.Subscriber;
//   private zmqRunning = false;

//   // Subscription state
//   private blockSubscriptions = new Set<(blockHash: string) => void>();

//   // Connection state
//   private isConnected = false;
//   private connectionTimeout: number;
//   private maxBatchSize: number;

//   // Request tracking
//   private pendingRequests = new Map<
//     string,
//     {
//       resolve: (data: any) => void;
//       reject: (error: Error) => void;
//       timeout: NodeJS.Timeout;
//       type: 'block' | 'headers' | 'mempool';
//     }
//   >();

//   constructor(options: P2PNodeProviderOptions) {
//     super(options);

//     this.peers = options.peers;
//     this.network = options.network;
//     this.zmqEndpoint = options.zmqEndpoint;
//     this.connectionTimeout = options.connectionTimeout ?? 30000;
//     this.maxBatchSize = Math.min(options.maxBatchSize ?? 2000, 2000);
//     this.rateLimiter = new RateLimiter(options.rateLimits);

//     // Convert our NetworkConfig to bitcore-p2p NetworkConfig
//     const bitcoreNetwork = this.createBitcoreNetworkConfig();

//     // Initialize P2P pool (peers will be added in connect method)
//     this.pool = new Pool({
//       network: bitcoreNetwork,
//       maxSize: options.maxPeers ?? this.peers.length,
//       dnsSeed: false,
//       listenAddr: false,
//     });

//     this.setupPoolEventHandlers();
//   }

//   get connectionOptions() {
//     return {
//       type: this.type,
//       uniqName: this.uniqName,
//       peers: this.peers,
//       zmqEndpoint: this.zmqEndpoint,
//       network: this.network,
//       rateLimits: this.rateLimits,
//     };
//   }

//   /**
//    * Convert our NetworkConfig to bitcore-p2p NetworkConfig
//    */
//   private createBitcoreNetworkConfig(): BitcoreNetworkConfig {
//     return {
//       name: this.network.network,
//       pubkeyhash: 0x00, // Default, not critical for P2P connection
//       privatekey: 0x80, // Default, not critical for P2P connection
//       scripthash: 0x05, // Default, not critical for P2P connection
//       xpubkey: 0x0488b21e, // Default, not critical for P2P connection
//       xprivkey: 0x0488ade4, // Default, not critical for P2P connection
//       networkMagic: this.network.magicBytes ?? 0xf9beb4d9,
//       port: this.network.defaultPort ?? 8333,
//     };
//   }

//   /**
//    * Setup event handlers for P2P pool
//    */
//   private setupPoolEventHandlers(): void {
//     this.pool.on('peerready', (peer: Peer) => {
//       // Use first ready peer as active peer (can be enhanced to switch between peers)
//       if (!this.activePeer) {
//         this.activePeer = peer;
//         this.isConnected = true;
//         this.setupPeerEventHandlers(peer);
//       }
//     });

//     this.pool.on('peerdisconnect', (peer: Peer, addr: string) => {
//       if (this.activePeer === peer) {
//         this.activePeer = null;
//         this.isConnected = false;

//         // Try to switch to another connected peer
//         if (this.pool._connectedPeers && this.pool._connectedPeers.size > 0) {
//           const nextPeer = Array.from(this.pool._connectedPeers.values())[0];
//           if (nextPeer) {
//             this.activePeer = nextPeer;
//             this.isConnected = true;
//             this.setupPeerEventHandlers(nextPeer);
//           }
//         }
//       }
//     });

//     this.pool.on('peererror', (peer: Peer, error: any) => {
//       // Handle peer errors gracefully - connection manager will handle provider switching
//     });
//   }

//   /**
//    * Setup event handlers for individual peer
//    */
//   private setupPeerEventHandlers(peer: Peer): void {
//     // Handle block messages
//     peer.on('block', (message: any) => {
//       if (!message?.block?.hash || !message?.block?.toBuffer) {
//         return;
//       }

//       const blockHash = message.block.hash.toString('hex');
//       this.handleBlockResponse(blockHash, message.block.toBuffer());
//     });

//     // Handle headers messages
//     peer.on('headers', (message: any) => {
//       if (message?.headers) {
//         this.handleHeadersResponse(message.headers);
//       }
//     });

//     // Handle ping/pong for connection health
//     peer.on('ping', (message: any) => {
//       if (message?.nonce) {
//         peer.sendMessage(new Messages.Pong(message.nonce));
//       }
//     });
//   }

//   /**
//    * Handle block response from peer (no longer needed for individual tracking)
//    */
//   private handleBlockResponse(blockHash: string, blockBuffer: Buffer): void {
//     // This method is kept for compatibility but actual batch handling is done in requestBlocks
//     const request = this.pendingRequests.get(blockHash);
//     if (request && request.type === 'block') {
//       clearTimeout(request.timeout);
//       this.pendingRequests.delete(blockHash);

//       try {
//         const hexData = blockBuffer.toString('hex');
//         const parsedBlock = HexTransformer.parseBlockHex(hexData, this.network);
//         parsedBlock.hex = hexData;
//         request.resolve(parsedBlock);
//       } catch (error) {
//         request.reject(new Error(`Failed to parse block: ${error}`));
//       }
//     }
//   }

//   /**
//    * Handle headers response from peer
//    */
//   private handleHeadersResponse(headers: any[]): void {
//     // Handle headers response for batch operations
//     // This could be used for optimized block downloading strategy
//   }

//   /**
//    * Initialize ZMQ subscriber for new blocks if endpoint provided
//    */
//   private async initializeZMQ(): Promise<void> {
//     if (!this.zmqEndpoint) return;

//     try {
//       this.zmqSocket = new zmq.Subscriber();
//       this.zmqSocket.connect(this.zmqEndpoint);
//       this.zmqSocket.subscribe('hashblock');
//       this.zmqRunning = true;

//       // Handle new block notifications
//       this.processZMQMessages();
//     } catch (error) {
//       // ZMQ not available, will use P2P for new blocks
//       this.zmqSocket = undefined;
//       this.zmqRunning = false;
//     }
//   }

//   /**
//    * Process ZMQ messages in separate async function to avoid blocking
//    */
//   private async processZMQMessages(): Promise<void> {
//     if (!this.zmqSocket) return;

//     try {
//       for await (const [topic, message] of this.zmqSocket) {
//         if (!this.zmqRunning) break;

//         if (topic?.toString() === 'hashblock' && this.blockSubscriptions.size > 0) {
//           const blockHash = message?.toString('hex');
//           if (blockHash) {
//             // Notify all active subscriptions
//             this.blockSubscriptions.forEach((callback) => {
//               try {
//                 callback(blockHash);
//               } catch (error) {
//                 // Ignore callback errors to prevent one bad callback from breaking others
//               }
//             });
//           }
//         }
//       }
//     } catch (error) {
//       // ZMQ connection error, will fallback to P2P
//     }
//   }

//   /**
//    * Subscribe to new block events
//    */
//   public subscribeToNewBlocks(callback: (blockHash: string) => void): { unsubscribe: () => void } {
//     // Add callback to active subscriptions
//     this.blockSubscriptions.add(callback);

//     // Initialize ZMQ or P2P subscription if this is the first subscription
//     if (this.blockSubscriptions.size === 1) {
//       this.initializeBlockSubscription();
//     }

//     return {
//       unsubscribe: () => {
//         this.blockSubscriptions.delete(callback);

//         // Clean up if no more subscriptions
//         if (this.blockSubscriptions.size === 0) {
//           this.cleanupBlockSubscription();
//         }
//       },
//     };
//   }

//   /**
//    * Initialize block subscription (ZMQ or P2P)
//    */
//   private initializeBlockSubscription(): void {
//     if (this.zmqEndpoint && !this.zmqRunning) {
//       // Try to initialize ZMQ
//       this.initializeZMQ().catch(() => {
//         // ZMQ failed, fallback to P2P
//         this.initializeP2PSubscription();
//       });
//     } else {
//       // Use P2P subscription
//       this.initializeP2PSubscription();
//     }
//   }

//   /**
//    * Initialize P2P inventory subscription
//    */
//   private initializeP2PSubscription(): void {
//     if (!this.activePeer) return;

//     const inventoryHandler = (peer: Peer, message: any) => {
//       if (!message?.inventory || this.blockSubscriptions.size === 0) return;

//       message.inventory.forEach((item: any) => {
//         if (item?.type === 2 && item?.hash) {
//           // MSG_BLOCK
//           const blockHash = item.hash.toString('hex');
//           if (blockHash) {
//             // Notify all active subscriptions
//             this.blockSubscriptions.forEach((callback) => {
//               try {
//                 callback(blockHash);
//               } catch (error) {
//                 // Ignore callback errors
//               }
//             });
//           }
//         }
//       });
//     };

//     this.pool.on('peerinv', inventoryHandler);

//     // Store handler for cleanup
//     (this as any)._p2pInventoryHandler = inventoryHandler;
//   }

//   /**
//    * Clean up block subscription
//    */
//   private cleanupBlockSubscription(): void {
//     // Stop ZMQ if running
//     if (this.zmqSocket && this.zmqRunning) {
//       this.zmqRunning = false;
//       this.zmqSocket.close();
//       this.zmqSocket = undefined;
//     }

//     // Remove P2P inventory handler
//     if ((this as any)._p2pInventoryHandler) {
//       this.pool.removeListener('peerinv', (this as any)._p2pInventoryHandler);
//       delete (this as any)._p2pInventoryHandler;
//     }
//   }

//   /**
//    * Handle connection errors and attempt recovery
//    */
//   async handleConnectionError(error: any, methodName: string): Promise<void> {
//     throw error; // Re-throw to let connection manager handle provider switching
//   }

//   public async connect(): Promise<void> {
//     // Add all peers to the pool
//     this.peers.forEach((peerConfig) => {
//       const peer = new Peer({
//         host: peerConfig.host,
//         port: peerConfig.port,
//       });
//       this.pool.addPeer(peer);
//     });

//     // Connect P2P pool
//     this.pool.connect();

//     // Wait for peer connection
//     await new Promise<void>((resolve, reject) => {
//       const timeout = setTimeout(() => {
//         reject(new Error('P2P connection timeout'));
//       }, this.connectionTimeout);

//       this.pool.once('peerready', () => {
//         clearTimeout(timeout);
//         resolve();
//       });
//     });

//     // Don't initialize ZMQ here - it will be initialized when first subscription is created
//   }

//   public async healthcheck(): Promise<boolean> {
//     return this.isConnected && this.activePeer !== null;
//   }

//   public async disconnect(): Promise<void> {
//     // Stop rate limiter
//     await this.rateLimiter.stop();

//     // Clear pending requests
//     for (const [key, request] of this.pendingRequests) {
//       clearTimeout(request.timeout);
//       request.reject(new Error('Provider disconnecting'));
//     }
//     this.pendingRequests.clear();

//     // Clean up all subscriptions
//     this.cleanupBlockSubscription();
//     this.blockSubscriptions.clear();

//     // Disconnect P2P pool
//     this.pool.disconnect();
//     this.activePeer = null;
//     this.isConnected = false;
//   }

//   /**
//    * Execute request with automatic error handling and provider switching
//    */
//   private async executeWithErrorHandling<T>(operation: () => Promise<T>, methodName: string): Promise<T> {
//     try {
//       return await operation();
//     } catch (error) {
//       await this.handleConnectionError(error, methodName);
//       throw error; // This will trigger provider switching in connection manager
//     }
//   }

//   /**
//    * Request multiple blocks data from peer in single GetData request
//    */
//   private async requestBlocks(hashes: string[]): Promise<UniversalBlock[]> {
//     if (!this.activePeer) {
//       throw new Error('No active peer connection');
//     }

//     return new Promise<UniversalBlock[]>((resolve, reject) => {
//       const expectedHashes = new Set(hashes);
//       const receivedBlocks = new Map<string, UniversalBlock>();

//       const batchTimeout = setTimeout(() => {
//         this.activePeer?.removeListener('block', onBlock);
//         reject(new Error(`Batch request timeout for ${hashes.length} blocks`));
//       }, 120000); // 2 minutes for batch - adjust based on your speed

//       const onBlock = (message: any) => {
//         if (!message?.block?.hash || !message?.block?.toBuffer) {
//           return;
//         }

//         const blockHash = message.block.hash.toString('hex');
//         if (!expectedHashes.has(blockHash)) {
//           return; // Not our block
//         }

//         try {
//           const hexData = message.block.toBuffer().toString('hex');
//           const parsedBlock = HexTransformer.parseBlockHex(hexData, this.network);
//           parsedBlock.hex = hexData;
//           receivedBlocks.set(blockHash, parsedBlock);
//           expectedHashes.delete(blockHash);

//           // Check if we got all blocks
//           if (expectedHashes.size === 0) {
//             clearTimeout(batchTimeout);
//             this.activePeer?.removeListener('block', onBlock);

//             // Return blocks in original order
//             const result = hashes.map((hash) => receivedBlocks.get(hash)!);
//             resolve(result);
//           }
//         } catch (error) {
//           // Skip invalid blocks but continue waiting for others
//         }
//       };

//       // Set up listener
//       this.activePeer?.on('block', onBlock);

//       try {
//         // Send single GetData with all block hashes
//         const inventory = hashes.map((hash) => ({
//           type: 2, // MSG_BLOCK
//           hash: Buffer.from(hash, 'hex').reverse(),
//         }));

//         const getDataMessage = new Messages.GetData(inventory);

//         // Double check peer is still active
//         if (!this.activePeer) {
//           clearTimeout(batchTimeout);
//           reject(new Error('Active peer disconnected during batch request'));
//           return;
//         }

//         this.activePeer.sendMessage(getDataMessage);
//       } catch (error) {
//         clearTimeout(batchTimeout);
//         this.activePeer?.removeListener('block', onBlock);
//         reject(new Error(`Failed to send batch request: ${error}`));
//       }
//     });
//   }

//   /**
//    * Split array into chunks of specified size
//    */
//   private chunkArray<T>(array: T[], chunkSize: number): T[][] {
//     const chunks: T[][] = [];
//     for (let i = 0; i < array.length; i += chunkSize) {
//       chunks.push(array.slice(i, i + chunkSize));
//     }
//     return chunks;
//   }

//   // ===== BASIC BLOCKCHAIN METHODS =====

//   public async getBlockHeight(): Promise<number> {
//     return this.executeWithErrorHandling(async () => {
//       throw new Error('getBlockHeight not directly available via P2P - use RPC provider for this');
//     }, 'getBlockHeight');
//   }

//   public async getManyBlockHashesByHeights(heights: number[]): Promise<string[]> {
//     return this.executeWithErrorHandling(async () => {
//       throw new Error('getManyBlockHashesByHeights not available via P2P - use RPC provider for this');
//     }, 'getManyBlockHashesByHeights');
//   }

//   // ===== HEX METHODS (parse hex to Universal objects) =====

//   /**
//    * Get multiple blocks parsed from hex as Universal objects - ATOMIC METHOD
//    */
//   public async getManyBlocksHexByHashes(hashes: string[]): Promise<(UniversalBlock | null)[]> {
//     return this.executeWithErrorHandling(async () => {
//       if (!this.activePeer) {
//         throw new Error('No active peer connection');
//       }

//       // Split into batches to avoid overwhelming the peer
//       const chunks = this.chunkArray(hashes, this.maxBatchSize);
//       const results: (UniversalBlock | null)[] = [];

//       for (const chunk of chunks) {
//         const chunkResults = await this.rateLimiter.execute(
//           chunk.map((hash) => ({ method: 'getblock', params: [hash] })),
//           async () => {
//             try {
//               // Request entire batch with single GetData message
//               const blocks = await this.requestBlocks(chunk);
//               return blocks;
//             } catch (error) {
//               // If batch fails, return nulls for all blocks in chunk
//               return new Array(chunk.length).fill(null);
//             }
//           }
//         );

//         results.push(...chunkResults);
//       }

//       return results;
//     }, 'getManyBlocksHexByHashes');
//   }

//   /**
//    * Get multiple blocks parsed from hex by heights as Universal objects - COMBINED METHOD
//    */
//   public async getManyBlocksHexByHeights(heights: number[]): Promise<(UniversalBlock | null)[]> {
//     return this.executeWithErrorHandling(async () => {
//       throw new Error('getManyBlocksHexByHeights not available via P2P without header chain - use RPC provider');
//     }, 'getManyBlocksHexByHeights');
//   }

//   // ===== OBJECT METHODS (return Universal*) =====

//   /**
//    * Get multiple blocks as structured objects - ATOMIC METHOD
//    */
//   public async getManyBlocksByHashes(hashes: string[], verbosity: number = 1): Promise<(UniversalBlock | null)[]> {
//     // For P2P, we always get full block data (equivalent to verbosity = 1)
//     return this.getManyBlocksHexByHashes(hashes);
//   }

//   /**
//    * Get multiple blocks by heights as structured objects - COMBINED METHOD
//    */
//   public async getManyBlocksByHeights(heights: number[], verbosity: number = 1): Promise<(UniversalBlock | null)[]> {
//     throw new Error('getManyBlocksByHeights not available via P2P without header chain - use RPC provider');
//   }

//   // ===== BLOCK STATS METHODS =====

//   public async getManyBlocksStatsByHashes(hashes: string[]): Promise<(UniversalBlockStats | null)[]> {
//     return this.executeWithErrorHandling(async () => {
//       // Get blocks first, then extract stats
//       const blocks = await this.getManyBlocksHexByHashes(hashes);

//       return blocks.map((block) => {
//         if (!block) return null;

//         // Create stats from block data
//         return this.createBlockStatsFromBlock(block);
//       });
//     }, 'getManyBlocksStatsByHashes');
//   }

//   public async getManyBlocksStatsByHeights(heights: number[]): Promise<(UniversalBlockStats | null)[]> {
//     throw new Error('getManyBlocksStatsByHeights not available via P2P without header chain - use RPC provider');
//   }

//   /**
//    * Create block stats from block data
//    */
//   private createBlockStatsFromBlock(block: UniversalBlock): UniversalBlockStats {
//     if (block.height === undefined || block.height === null) {
//       throw new Error(`Block height is missing for block ${block.hash}`);
//     }

//     return {
//       blockhash: block.hash,
//       height: block.height,
//       total_size: block.size || 0,
//       total_weight: block.weight || 0,
//       txs: block.nTx || block.tx?.length || 0,
//     };
//   }

//   /**
//    * Get multiple transactions as structured objects - ATOMIC METHOD
//    */
//   public async getManyTransactionsByTxids(
//     txids: string[],
//     verbosity: number = 1
//   ): Promise<(UniversalTransaction | null)[]> {
//     throw new Error('getManyTransactionsByTxids not available via P2P - use RPC provider');
//   }

//   /**
//    * Get multiple transactions parsed from hex as Universal objects - ATOMIC METHOD
//    */
//   public async getManyTransactionsHexByTxids(txids: string[]): Promise<(UniversalTransaction | null)[]> {
//     throw new Error('getManyTransactionsHexByTxids not available via P2P - use RPC provider');
//   }

//   // ===== NETWORK METHODS =====

//   public async getBlockchainInfo(): Promise<any> {
//     throw new Error('getBlockchainInfo not available via P2P - use RPC provider');
//   }

//   public async getNetworkInfo(): Promise<any> {
//     throw new Error('getNetworkInfo not available via P2P - use RPC provider');
//   }

//   public async estimateSmartFee(confTarget: number, estimateMode: string = 'CONSERVATIVE'): Promise<any> {
//     throw new Error('estimateSmartFee not available via P2P - use RPC provider');
//   }

//   public async getMempoolInfo(): Promise<UniversalMempoolInfo> {
//     throw new Error('getMempoolInfo not available via P2P - use RPC provider');
//   }

//   public async getRawMempool(verbose: boolean = false): Promise<any> {
//     throw new Error('getRawMempool not available via P2P - use RPC provider');
//   }

//   public async getMempoolEntries(txids: string[]): Promise<(UniversalMempoolTransaction | null)[]> {
//     throw new Error('getMempoolEntries not available via P2P - use RPC provider');
//   }
// }
