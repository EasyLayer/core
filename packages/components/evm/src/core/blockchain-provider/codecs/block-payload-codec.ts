import type { Block } from '../components/block.interfaces';

export const EVM_MSGPACK_CODEC_ID = 'evm-msgpack-v1';
export const EVM_JSON_CODEC_ID = 'evm-json-v1';

type MessagePackValue =
  | null
  | boolean
  | number
  | string
  | MessagePackValue[]
  | { [key: string]: MessagePackValue | undefined };

class MessagePackWriter {
  private readonly chunks: Buffer[] = [];

  write(value: MessagePackValue | undefined): void {
    if (value === undefined || value === null) {
      this.pushByte(0xc0);
      return;
    }
    if (typeof value === 'boolean') {
      this.pushByte(value ? 0xc3 : 0xc2);
      return;
    }
    if (typeof value === 'number') {
      this.writeNumber(value);
      return;
    }
    if (typeof value === 'string') {
      this.writeString(value);
      return;
    }
    if (Array.isArray(value)) {
      this.writeArray(value);
      return;
    }
    this.writeObject(value);
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }

  private pushByte(byte: number): void {
    this.chunks.push(Buffer.from([byte]));
  }

  private pushUInt16(prefix: number, value: number): void {
    const buffer = Buffer.allocUnsafe(3);
    buffer[0] = prefix;
    buffer.writeUInt16BE(value, 1);
    this.chunks.push(buffer);
  }

  private pushUInt32(prefix: number, value: number): void {
    const buffer = Buffer.allocUnsafe(5);
    buffer[0] = prefix;
    buffer.writeUInt32BE(value, 1);
    this.chunks.push(buffer);
  }

  private writeNumber(value: number): void {
    if (Number.isInteger(value)) {
      if (value >= 0 && value <= 0x7f) {
        this.pushByte(value);
        return;
      }
      if (value >= -32 && value < 0) {
        this.pushByte(0xe0 | (value + 32));
        return;
      }
      if (value >= 0 && value <= 0xff) {
        this.pushByte(0xcc);
        this.pushByte(value);
        return;
      }
      if (value >= 0 && value <= 0xffff) {
        this.pushUInt16(0xcd, value);
        return;
      }
      if (value >= 0 && value <= 0xffffffff) {
        this.pushUInt32(0xce, value);
        return;
      }
      if (value >= -0x80 && value < 0) {
        const buffer = Buffer.allocUnsafe(2);
        buffer[0] = 0xd0;
        buffer.writeInt8(value, 1);
        this.chunks.push(buffer);
        return;
      }
      if (value >= -0x8000 && value < 0) {
        const buffer = Buffer.allocUnsafe(3);
        buffer[0] = 0xd1;
        buffer.writeInt16BE(value, 1);
        this.chunks.push(buffer);
        return;
      }
      if (value >= -0x80000000 && value < 0) {
        const buffer = Buffer.allocUnsafe(5);
        buffer[0] = 0xd2;
        buffer.writeInt32BE(value, 1);
        this.chunks.push(buffer);
        return;
      }
    }

    const buffer = Buffer.allocUnsafe(9);
    buffer[0] = 0xcb;
    buffer.writeDoubleBE(value, 1);
    this.chunks.push(buffer);
  }

  private writeString(value: string): void {
    const bytes = Buffer.from(value, 'utf8');
    const length = bytes.length;
    if (length <= 31) {
      this.pushByte(0xa0 | length);
    } else if (length <= 0xff) {
      this.pushByte(0xd9);
      this.pushByte(length);
    } else if (length <= 0xffff) {
      this.pushUInt16(0xda, length);
    } else {
      this.pushUInt32(0xdb, length);
    }
    this.chunks.push(bytes);
  }

  private writeArray(value: MessagePackValue[]): void {
    const length = value.length;
    if (length <= 15) {
      this.pushByte(0x90 | length);
    } else if (length <= 0xffff) {
      this.pushUInt16(0xdc, length);
    } else {
      this.pushUInt32(0xdd, length);
    }
    for (const item of value) this.write(item);
  }

  private writeObject(value: { [key: string]: MessagePackValue | undefined }): void {
    const entries = Object.entries(value).filter(([, entryValue]) => entryValue !== undefined);
    const length = entries.length;
    if (length <= 15) {
      this.pushByte(0x80 | length);
    } else if (length <= 0xffff) {
      this.pushUInt16(0xde, length);
    } else {
      this.pushUInt32(0xdf, length);
    }
    for (const [key, entryValue] of entries) {
      this.writeString(key);
      this.write(entryValue);
    }
  }
}

class MessagePackReader {
  private offset = 0;

  constructor(private readonly bytes: Buffer) {}

  read(): MessagePackValue {
    const prefix = this.readUInt8();

    if (prefix <= 0x7f) return prefix;
    if (prefix >= 0xe0) return prefix - 0x100;
    if ((prefix & 0xe0) === 0xa0) return this.readString(prefix & 0x1f);
    if ((prefix & 0xf0) === 0x90) return this.readArray(prefix & 0x0f);
    if ((prefix & 0xf0) === 0x80) return this.readMap(prefix & 0x0f);

    switch (prefix) {
      case 0xc0:
        return null;
      case 0xc2:
        return false;
      case 0xc3:
        return true;
      case 0xcc:
        return this.readUInt8();
      case 0xcd:
        return this.readUInt16();
      case 0xce:
        return this.readUInt32();
      case 0xd0:
        return this.readInt8();
      case 0xd1:
        return this.readInt16();
      case 0xd2:
        return this.readInt32();
      case 0xcb:
        return this.readDouble();
      case 0xd9:
        return this.readString(this.readUInt8());
      case 0xda:
        return this.readString(this.readUInt16());
      case 0xdb:
        return this.readString(this.readUInt32());
      case 0xdc:
        return this.readArray(this.readUInt16());
      case 0xdd:
        return this.readArray(this.readUInt32());
      case 0xde:
        return this.readMap(this.readUInt16());
      case 0xdf:
        return this.readMap(this.readUInt32());
      default:
        throw new Error(`Unsupported MessagePack prefix: 0x${prefix.toString(16)}`);
    }
  }

  private readUInt8(): number {
    const value = this.bytes[this.offset];
    if (value === undefined) {
      throw new Error(`Unexpected end of MessagePack payload at offset ${this.offset}`);
    }
    this.offset += 1;
    return value;
  }

  private readUInt16(): number {
    const value = this.bytes.readUInt16BE(this.offset);
    this.offset += 2;
    return value;
  }

  private readUInt32(): number {
    const value = this.bytes.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  private readInt8(): number {
    const value = this.bytes.readInt8(this.offset);
    this.offset += 1;
    return value;
  }

  private readInt16(): number {
    const value = this.bytes.readInt16BE(this.offset);
    this.offset += 2;
    return value;
  }

  private readInt32(): number {
    const value = this.bytes.readInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  private readDouble(): number {
    const value = this.bytes.readDoubleBE(this.offset);
    this.offset += 8;
    return value;
  }

  private readString(length: number): string {
    const end = this.offset + length;
    const value = this.bytes.toString('utf8', this.offset, end);
    this.offset = end;
    return value;
  }

  private readArray(length: number): MessagePackValue[] {
    const value: MessagePackValue[] = [];
    for (let i = 0; i < length; i++) value.push(this.read());
    return value;
  }

  private readMap(length: number): { [key: string]: MessagePackValue } {
    const value: { [key: string]: MessagePackValue } = {};
    for (let i = 0; i < length; i++) {
      const key = this.read();
      if (typeof key !== 'string') throw new Error('MessagePack map key must be a string');
      value[key] = this.read();
    }
    return value;
  }
}

function firstNonWhitespaceByte(bytes: Buffer): number | undefined {
  for (const byte of bytes) {
    if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) return byte;
  }
  return undefined;
}

export function encodeEvmBlockPayload(block: Block): Buffer {
  const writer = new MessagePackWriter();
  writer.write(block as unknown as MessagePackValue);
  return writer.toBuffer();
}

export function decodeEvmBlockPayload(bytes: Buffer): Block {
  const first = firstNonWhitespaceByte(bytes);
  if (first === 0x7b || first === 0x5b) return JSON.parse(bytes.toString('utf8')) as Block;
  return new MessagePackReader(bytes).read() as unknown as Block;
}
