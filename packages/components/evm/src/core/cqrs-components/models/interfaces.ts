import type { LightBlock } from '../../blockchain-provider/components/block.interfaces';

export interface NetworkModelInterfaces {
  lastBlockHeight: number;
  getLastBlock(): LightBlock | undefined;
  getBlockByHeight(height: number): LightBlock | null;
  getLastNBlocks(count: number): LightBlock[];
}
