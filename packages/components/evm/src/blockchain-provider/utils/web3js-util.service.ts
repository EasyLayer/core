import * as Web3Module from 'web3';
const Web3 = (Web3Module as any).default ?? Web3Module;
// import BN from "bn.js";

export class Web3Util {
  static getEventSignature(eventSignature: string): string {
    return Web3.utils.keccak256(eventSignature).toLowerCase();
  }

  //   static hexToBigInt(hex: string): bigint {
  //     const bn = new BN(hex.replace(/^0x/, ""), 16);
  //     return BigInt(bn.toString());
  //   }

  static bigIntToString(value: bigint): string {
    return value.toString();
  }

  static normalizeAddress(address: string): string {
    try {
      return Web3.utils.toChecksumAddress(address);
    } catch (error) {
      return address.toLowerCase();
    }
  }

  //   static decodeERC20Transfer(log: Log): { from: string; to: string; value: string } {
  //     // Extract addresses from topics (take the last 40 characters to get 20 bytes)
  //     const from = "0x" + log.topics[1].slice(-40);
  //     const to = "0x" + log.topics[2].slice(-40);
  //     // Convert log.data to BigInt, then to string
  //     const value = Web3Util.hexToBigInt(log.data).toString();
  //     return { from, to, value };
  //   }

  static formatEther(weiValue: string): string {
    return Web3.utils.fromWei(weiValue, 'ether');
  }

  static hexToBuffer(hex: string): Buffer {
    return Buffer.from(hex.replace(/^0x/, ''), 'hex');
  }

  static bufferToHex(buffer: Buffer): string {
    return '0x' + buffer.toString('hex');
  }
}
