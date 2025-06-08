import { id, getAddress, formatEther } from 'ethers';
import type { Log } from '../components';

/**
 * Utility class for working with ethers.js library
 * Provides common blockchain operations and data transformations
 */
export class EtherJSUtil {
  /**
   * Generates event signature hash from event signature string
   * @param eventSignature - Event signature like "Transfer(address,address,uint256)"
   * @returns Lowercase hex string of the keccak256 hash
   */
  static getEventSignature(eventSignature: string): string {
    return id(eventSignature).toLowerCase();
  }

  /**
   * Converts hex string to BigInt
   * @param hex - Hex string (with or without 0x prefix)
   * @returns BigInt representation
   */
  static hexToBigInt(hex: string): bigint {
    return BigInt(hex);
  }

  /**
   * Converts BigInt to string
   * @param value - BigInt value
   * @returns String representation
   */
  static bigIntToString(value: bigint): string {
    return value.toString();
  }

  /**
   * Normalizes address to checksum format
   * @param address - Ethereum address
   * @returns Checksummed address or lowercase if invalid
   */
  static normalizeAddress(address: string): string {
    try {
      return getAddress(address);
    } catch (error) {
      return address.toLowerCase();
    }
  }

  /**
   * Decodes ERC-20 Transfer event from log data
   * @param log - Transaction log containing Transfer event
   * @returns Decoded transfer data with from, to, and value
   */
  static decodeERC20Transfer(log: Log): { from: string; to: string; value: string } {
    // Extract addresses from topics (take the last 40 characters to get 20 bytes)
    const from = '0x' + log.topics[1]!.slice(-40);
    const to = '0x' + log.topics[2]!.slice(-40);

    // Convert log.data to BigInt, then to string
    const value = EtherJSUtil.hexToBigInt(log.data).toString();

    return { from, to, value };
  }

  /**
   * Formats wei value to ether with proper decimals
   * @param weiValue - Wei amount as string
   * @returns Formatted ether amount as string
   */
  static formatEther(weiValue: string): string {
    return formatEther(weiValue);
  }

  /**
   * Converts hex string to Buffer
   * @param hex - Hex string (with or without 0x prefix)
   * @returns Buffer representation
   */
  static hexToBuffer(hex: string): Buffer {
    return Buffer.from(hex.replace(/^0x/, ''), 'hex');
  }

  /**
   * Converts Buffer to hex string with 0x prefix
   * @param buffer - Buffer to convert
   * @returns Hex string with 0x prefix
   */
  static bufferToHex(buffer: Buffer): string {
    return '0x' + buffer.toString('hex');
  }

  /**
   * Formats any token amount to human readable format
   * @param amount - Token amount in smallest unit (like wei)
   * @param decimals - Number of decimals for the token
   * @returns Formatted amount as string
   */
  static formatTokenAmount(amount: string, decimals: number): string {
    const divisor = BigInt(10 ** decimals);
    const amountBigInt = BigInt(amount);
    const wholePart = amountBigInt / divisor;
    const fractionalPart = amountBigInt % divisor;

    if (fractionalPart === 0n) {
      return wholePart.toString();
    }

    const fractionalStr = fractionalPart.toString().padStart(decimals, '0');
    const trimmedFractional = fractionalStr.replace(/0+$/, '');

    return `${wholePart}.${trimmedFractional}`;
  }

  /**
   * Parses token amount from human readable format to smallest unit
   * @param amount - Human readable amount (like "1.5")
   * @param decimals - Number of decimals for the token
   * @returns Amount in smallest unit as string
   */
  static parseTokenAmount(amount: string, decimals: number): string {
    const [wholePart, fractionalPart = ''] = amount.split('.');
    const paddedFractional = fractionalPart.padEnd(decimals, '0').slice(0, decimals);
    const fullAmount = wholePart + paddedFractional;

    return BigInt(fullAmount).toString();
  }

  /**
   * Checks if a string is a valid Ethereum address
   * @param address - String to validate
   * @returns True if valid address format
   */
  static isValidAddress(address: string): boolean {
    try {
      getAddress(address);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Checks if a string is a valid transaction hash
   * @param hash - String to validate
   * @returns True if valid transaction hash format
   */
  static isValidTransactionHash(hash: string): boolean {
    return /^0x[a-fA-F0-9]{64}$/.test(hash);
  }

  /**
   * Generates a random private key
   * @returns Random 32-byte private key as hex string
   */
  static generateRandomPrivateKey(): string {
    const randomBytes = new Uint8Array(32);
    crypto.getRandomValues(randomBytes);
    return (
      '0x' +
      Array.from(randomBytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
    );
  }

  /**
   * Converts gas price from gwei to wei
   * @param gwei - Gas price in gwei
   * @returns Gas price in wei as string
   */
  static gweiToWei(gwei: string): string {
    const gweiAmount = BigInt(Math.floor(parseFloat(gwei) * 1e9));
    return gweiAmount.toString();
  }

  /**
   * Converts gas price from wei to gwei
   * @param wei - Gas price in wei
   * @returns Gas price in gwei as string
   */
  static weiToGwei(wei: string): string {
    const weiAmount = BigInt(wei);
    const gweiAmount = weiAmount / BigInt(1e9);
    const remainder = weiAmount % BigInt(1e9);

    if (remainder === 0n) {
      return gweiAmount.toString();
    }

    return (Number(weiAmount) / 1e9).toString();
  }
}
