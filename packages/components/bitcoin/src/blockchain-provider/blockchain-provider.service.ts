import { Injectable } from '@nestjs/common';
import { AppLogger } from '@easylayer/common/logger';
import { ConnectionManager } from './connection-manager';
import { Hash } from './node-providers';

@Injectable()
export class BlockchainProviderService {
  constructor(
    private readonly log: AppLogger,
    private readonly _connectionManager: ConnectionManager
  ) {}

  get connectionManager() {
    return this._connectionManager;
  }

  public async getCurrentBlockHeight(): Promise<number> {
    try {
      const provider = await this._connectionManager.getActiveProvider();
      const height = await provider.getBlockHeight();
      return Number(height);
    } catch (error) {
      this.log.debug('Failed to get current block height', {
        args: { error },
      });
      throw error;
    }
  }

  public async getOneBlockHashByHeight(height: string | number): Promise<any> {
    try {
      const provider = await this._connectionManager.getActiveProvider();
      return await provider.getOneBlockHashByHeight(Number(height));
    } catch (error) {
      this.log.debug('Failed to get block hash by height', {
        args: { height, error },
      });
      throw error;
    }
  }

  public async getOneBlockByHeight(height: string | number, verbosity?: number): Promise<any> {
    try {
      const provider = await this._connectionManager.getActiveProvider();
      return await provider.getOneBlockByHeight(Number(height), verbosity);
    } catch (error) {
      this.log.debug('Failed to get block by height', {
        args: { height, verbosity, error },
      });
      throw error;
    }
  }

  public async getManyBlocksByHeights(heights: string[] | number[], verbosity?: number): Promise<any> {
    try {
      const provider = await this._connectionManager.getActiveProvider();
      return await provider.getManyBlocksByHeights(
        heights.map((item) => Number(item)),
        verbosity
      );
    } catch (error) {
      this.log.debug('Failed to get many blocks by heights', {
        args: { heights, verbosity, error },
      });
      throw error;
    }
  }

  public async getManyBlocksStatsByHeights(heights: string[] | number[]): Promise<any> {
    try {
      const provider = await this._connectionManager.getActiveProvider();
      return await provider.getManyBlocksStatsByHeights(heights.map((item) => Number(item)));
    } catch (error) {
      this.log.debug('Failed to get many blocks stats by heights', {
        args: { heights, error },
      });
      throw error;
    }
  }

  public async getOneBlockByHash(hash: string | Hash, verbosity?: number): Promise<any> {
    try {
      const provider = await this._connectionManager.getActiveProvider();
      // TODO: add method transform into Hash
      return await provider.getOneBlockByHash(hash as Hash, verbosity);
    } catch (error) {
      this.log.debug('Failed to get block by hash', {
        args: { hash, verbosity, error },
      });
      throw error;
    }
  }

  public async getManyBlocksByHashes(hashes: string[] | Hash[], verbosity?: number): Promise<any> {
    try {
      const provider = await this._connectionManager.getActiveProvider();
      // TODO: add method transform into Hash
      const blocks = await provider.getManyBlocksByHashes(hashes as Hash[], verbosity);
      return blocks.filter((block: any) => block);
    } catch (error) {
      this.log.debug('Failed to get many blocks by hashes', {
        args: { hashes, verbosity, error },
      });
      throw error;
    }
  }

  public async getOneTransactionByHash(hash: string | Hash): Promise<any> {
    try {
      const provider = await this._connectionManager.getActiveProvider();
      // TODO: add method transform into Hash
      return await provider.getOneTransactionByHash(hash as Hash);
    } catch (error) {
      this.log.debug('Failed to get transaction by hash', {
        args: { hash, error },
      });
      throw error;
    }
  }

  public async getManyTransactionsByHashes(hashes: string[] | Hash[]): Promise<any> {
    try {
      const provider = await this._connectionManager.getActiveProvider();
      // TODO: add method transform into Hash
      return await provider.getManyTransactionsByHashes(hashes as Hash[]);
    } catch (error) {
      this.log.debug('Failed to get many transactions by hashes', {
        args: { hashes, error },
      });
      throw error;
    }
  }
}
