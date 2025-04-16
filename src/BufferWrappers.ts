export class BufferOverflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BufferOverflowError';
  }
}

export class BufferReader {
  private offset: number;

  constructor(private buffer: Buffer) {
    this.offset = 0;
  }

  get length() {
    return this.buffer.length;
  }
  get remaining() {
    return this.buffer.length - this.offset;
  }
  get position() {
    return this.offset;
  }

  readNumber(size: number) {
    if (!Number.isInteger(size)) throw new Error('Size must be an integer');
    if (size < 1) throw new Error('Size too small');
    if (size > 8) throw new Error('Size too large');
    if (size > 6) {
      if (this.readNumber(size - 6)) throw new Error('Number too large');
      size = 6;
    }
    if (this.offset + size > this.buffer.length) throw new BufferOverflowError('Reading number past end of buffer');

    const value: number = this.buffer.readUIntBE(this.offset, size);
    this.offset += size;
    return value;
  }

  readSlice(length?: number) {
    if (length !== undefined && this.offset + length > this.buffer.length) {
      throw new BufferOverflowError('Reading slice past end of buffer');
    }
    const value = this.buffer.slice(this.offset, length !== undefined ? this.offset + length : undefined);
    this.offset += value.length;
    return value;
  }

  readSizedBuffer(lengthSize = 2) {
    const length = this.buffer.readUIntBE(this.offset, lengthSize);
    if (this.remaining < length + lengthSize) throw new BufferOverflowError('Reading sized buffer past end of buffer');
    this.offset += lengthSize;

    return this.readSlice(length);
  }

  readString(size?: number) {
    const value = this.readSlice(size).toString('utf8');
    return value;
  }
}

export class BufferWriter {
  constructor(public buffer: Buffer) {}

  private offset = 0;

  get length() {
    return this.buffer.length;
  }
  get remaining() {
    return this.buffer.length - this.offset;
  }

  get position() {
    return this.offset;
  }

  getTrimmed() {
    return this.buffer.subarray(0, this.offset);
  }

  writeNumber(size: number, value: number) {
    if (!Number.isInteger(size)) throw new Error('Size must be an integer');
    if (size < 1) throw new Error('Size too small');
    if (size > 8) throw new Error('Size too large');
    if (this.remaining < size) throw new Error('Buffer overflow');
    if (size > 6) {
      this.writeNumber(size - 6, 0);
      size = 6;
    }

    this.buffer.writeUIntBE(value, this.offset, size);
    this.offset += size;
  }

  writeBuffer(buff: Buffer) {
    if (this.remaining < buff.length) throw new Error('Buffer overflow');
    buff.copy(this.buffer, this.offset);
    this.offset += buff.length;
  }
}
