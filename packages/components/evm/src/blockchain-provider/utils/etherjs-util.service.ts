import { id, getAddress, formatEther } from 'ethers';
import type { Log } from '../components';

export class EtherJSUtil {
  static getEventSignature(eventSignature: string): string {
    return id(eventSignature).toLowerCase();
  }

  static hexToBigInt(hex: string): bigint {
    return BigInt(hex);
  }

  static bigIntToString(value: bigint): string {
    return value.toString();
  }

  static normalizeAddress(address: string): string {
    try {
      return getAddress(address);
    } catch (error) {
      return address.toLowerCase();
    }
  }

  static decodeERC20Transfer(log: Log): { from: string; to: string; value: string } {
    const from = '0x' + log.topics[1]!.slice(-40);
    const to = '0x' + log.topics[2]!.slice(-40);
    const value = EtherJSUtil.hexToBigInt(log.data).toString();
    return { from, to, value };
  }

  static formatEther(weiValue: string): string {
    return formatEther(weiValue);
  }

  static hexToBuffer(hex: string): Buffer {
    return Buffer.from(hex.replace(/^0x/, ''), 'hex');
  }

  static bufferToHex(buffer: Buffer): string {
    return '0x' + buffer.toString('hex');
  }
}
