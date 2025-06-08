import * as Web3Module from 'web3';
import type { Log } from '../components';

// Handle different import styles for Web3
const Web3 = (Web3Module as any).default ?? Web3Module;

/**
 * Utility class for working with web3.js library
 * Provides common blockchain operations and data transformations
 */
export class Web3Util {
  /**
   * Generates event signature hash from event signature string
   * @param eventSignature - Event signature like "Transfer(address,address,uint256)"
   * @returns Lowercase hex string of the keccak256 hash
   */
  static getEventSignature(eventSignature: string): string {
    return Web3.utils.keccak256(eventSignature).toLowerCase();
  }

  /**
   * Converts hex string to BigInt
   * @param hex - Hex string (with or without 0x prefix)
   * @returns BigInt representation
   */
  static hexToBigInt(hex: string): bigint {
    // Remove 0x prefix and convert to BigInt
    const cleanHex = hex.replace(/^0x/, '');
    return BigInt('0x' + cleanHex);
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
      return Web3.utils.toChecksumAddress(address);
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
    const value = Web3Util.hexToBigInt(log.data).toString();

    return { from, to, value };
  }

  /**
   * Formats wei value to ether with proper decimals
   * @param weiValue - Wei amount as string
   * @returns Formatted ether amount as string
   */
  static formatEther(weiValue: string): string {
    return Web3.utils.fromWei(weiValue, 'ether');
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
    return Web3.utils.isAddress(address);
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
    return Web3.utils.toWei(gwei, 'gwei');
  }

  /**
   * Converts gas price from wei to gwei
   * @param wei - Gas price in wei
   * @returns Gas price in gwei as string
   */
  static weiToGwei(wei: string): string {
    return Web3.utils.fromWei(wei, 'gwei');
  }

  /**
   * Converts ether to wei
   * @param ether - Ether amount as string
   * @returns Wei amount as string
   */
  static etherToWei(ether: string): string {
    return Web3.utils.toWei(ether, 'ether');
  }

  /**
   * Converts wei to ether
   * @param wei - Wei amount as string
   * @returns Ether amount as string
   */
  static weiToEther(wei: string): string {
    return Web3.utils.fromWei(wei, 'ether');
  }

  /**
   * Encodes function call data
   * @param functionAbi - ABI definition of the function
   * @param parameters - Parameters to encode
   * @returns Encoded function call data
   */
  static encodeFunctionCall(functionAbi: any, parameters: any[]): string {
    return Web3.utils.encodeFunctionCall(functionAbi, parameters);
  }

  /**
   * Decodes function call data
   * @param functionAbi - ABI definition of the function
   * @param data - Encoded function call data
   * @returns Decoded parameters
   */
  static decodeFunctionCall(functionAbi: any, data: string): any {
    return Web3.utils.decodeFunctionCall(functionAbi, data);
  }

  /**
   * Encodes parameters according to ABI specification
   * @param types - Array of parameter types
   * @param values - Array of parameter values
   * @returns Encoded parameters as hex string
   */
  static encodeParameters(types: string[], values: any[]): string {
    return Web3.utils.encodeParameters(types, values);
  }

  /**
   * Decodes parameters according to ABI specification
   * @param types - Array of parameter types
   * @param data - Encoded data to decode
   * @returns Decoded parameters
   */
  static decodeParameters(types: string[], data: string): any {
    return Web3.utils.decodeParameters(types, data);
  }

  /**
   * Generates random hex string of specified length
   * @param length - Length in bytes
   * @returns Random hex string with 0x prefix
   */
  static randomHex(length: number): string {
    return Web3.utils.randomHex(length);
  }

  /**
   * Converts number to hex string
   * @param value - Number to convert
   * @returns Hex string with 0x prefix
   */
  static numberToHex(value: number | string): string {
    return Web3.utils.numberToHex(value);
  }

  /**
   * Converts hex string to number
   * @param hex - Hex string to convert
   * @returns Number value
   */
  static hexToNumber(hex: string): number {
    return Web3.utils.hexToNumber(hex);
  }

  /**
   * Pads hex string to specified length
   * @param hex - Hex string to pad
   * @param length - Target length in bytes
   * @param left - Whether to pad on the left (default: true)
   * @returns Padded hex string
   */
  static padHex(hex: string, length: number, left: boolean = true): string {
    if (left) {
      return Web3.utils.padLeft(hex, length * 2);
    } else {
      return Web3.utils.padRight(hex, length * 2);
    }
  }
}
