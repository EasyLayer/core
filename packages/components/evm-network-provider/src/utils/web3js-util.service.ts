// Web3Util.ts
import Web3 from 'web3';
// import BN from "bn.js";

/**
 * Класс-утилита для работы с web3.js.
 *
 * Предоставляет методы для:
 * - получения сигнатур событий,
 * - преобразования hex-строк в BigInt и обратно,
 * - нормализации адресов,
 * - декодирования логов стандартного события ERC20 Transfer,
 * - форматирования wei в ETH,
 * - преобразования hex-строк в Buffer и обратно.
 */
export class Web3Util {
  /**
   * Возвращает сигнатуру события (topic0) в нижнем регистре,
   * вычисленную на основе строки сигнатуры (например, "Transfer(address,address,uint256)").
   * @param eventSignature Строка сигнатуры события.
   * @returns Сигнатура события (хэш keccak256) в нижнем регистре.
   */
  static getEventSignature(eventSignature: string): string {
    return Web3.utils.keccak256(eventSignature).toLowerCase();
  }

  /**
   * Преобразует шестнадцатеричную строку в BigInt.
   * Использует bn.js для создания BN-объекта.
   * @param hex Шестнадцатеричная строка, например "0x1a".
   * @returns BigInt значение.
   */
  //   static hexToBigInt(hex: string): bigint {
  //     const bn = new BN(hex.replace(/^0x/, ""), 16);
  //     return BigInt(bn.toString());
  //   }

  /**
   * Преобразует BigInt в строку в десятичном формате.
   * @param value BigInt значение.
   * @returns Строка с десятичным представлением.
   */
  static bigIntToString(value: bigint): string {
    return value.toString();
  }

  /**
   * Нормализует адрес, возвращая его в формате checksum.
   * Если адрес некорректен, возвращает его в нижнем регистре.
   * @param address Адрес в виде строки.
   * @returns Нормализованный адрес.
   */
  static normalizeAddress(address: string): string {
    try {
      return Web3.utils.toChecksumAddress(address);
    } catch (error) {
      return address.toLowerCase();
    }
  }

  /**
   * Декодирует лог события ERC20 Transfer.
   *
   * Предполагается, что:
   * - log.topics[0] — сигнатура события Transfer,
   * - log.topics[1] содержит адрес отправителя (с паддингом до 32 байт),
   * - log.topics[2] содержит адрес получателя (с паддингом до 32 байт),
   * - log.data содержит значение перевода в формате hex.
   *
   * @param log Лог события.
   * @returns Объект с полями from, to и value (значение перевода в виде строки).
   */
  //   static decodeERC20Transfer(log: Log): { from: string; to: string; value: string } {
  //     // Извлекаем адреса из topics (берем последние 40 символов, чтобы получить 20 байт)
  //     const from = "0x" + log.topics[1].slice(-40);
  //     const to = "0x" + log.topics[2].slice(-40);
  //     // Преобразуем log.data в BigInt, затем в строку
  //     const value = Web3Util.hexToBigInt(log.data).toString();
  //     return { from, to, value };
  //   }

  /**
   * Форматирует значение в wei в строку с ETH, используя Web3.utils.fromWei.
   * @param weiValue Значение в wei в виде строки (например, "1000000000000000000").
   * @returns Строка с отформатированным значением ETH.
   */
  static formatEther(weiValue: string): string {
    return Web3.utils.fromWei(weiValue, 'ether');
  }

  /**
   * Преобразует шестнадцатеричную строку в Buffer.
   * @param hex Шестнадцатеричная строка с префиксом "0x".
   * @returns Buffer.
   */
  static hexToBuffer(hex: string): Buffer {
    return Buffer.from(hex.replace(/^0x/, ''), 'hex');
  }

  /**
   * Преобразует Buffer в шестнадцатеричную строку с префиксом "0x".
   * @param buffer Buffer.
   * @returns Шестнадцатеричная строка.
   */
  static bufferToHex(buffer: Buffer): string {
    return '0x' + buffer.toString('hex');
  }
}
