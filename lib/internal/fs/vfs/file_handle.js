'use strict';

const {
  ObjectDefineProperty,
  Promise,
  PromiseResolve,
  SymbolAsyncDispose,
} = primordials;

const EventEmitter = require('events');
const { Buffer } = require('buffer');
const { EBADF } = require('internal/fs/vfs/errors');

const kHandle = Symbol('kHandle');
const kFd = Symbol('kFd');
const kPath = Symbol('kPath');
const kFlags = Symbol('kFlags');
const kMode = Symbol('kMode');
const kProvider = Symbol('kProvider');
const kClosed = Symbol('kClosed');
const kClosePromise = Symbol('kClosePromise');
const kPosition = Symbol('kPosition');

// VirtualFileHandle class compatible with fs.promises.FileHandle
class VirtualFileHandle extends EventEmitter {
  constructor(provider, path, flags, mode, handle) {
    super();
    this[kProvider] = provider;
    this[kPath] = path;
    this[kFlags] = flags;
    this[kMode] = mode;
    this[kHandle] = handle;
    this[kFd] = handle.fd || -1;
    this[kClosed] = false;
    this[kClosePromise] = null;
    this[kPosition] = 0;
  }

  get fd() {
    return this[kFd];
  }

  get path() {
    return this[kPath];
  }

  /**
   * Read data from file
   * @param {Buffer} buffer - Buffer to read into
   * @param {number} offset - Buffer offset
   * @param {number} length - Number of bytes to read
   * @param {number|null} position - File position (null = current)
   * @returns {Promise<{bytesRead: number, buffer: Buffer}>}
   */
  async read(buffer, offset, length, position) {
    if (this[kClosed]) {
      throw EBADF('read');
    }

    // Validate arguments
    if (!Buffer.isBuffer(buffer)) {
      throw new TypeError('buffer must be a Buffer');
    }

    offset = offset || 0;
    length = length === undefined ? buffer.length - offset : length;

    const pos = position !== null && position !== undefined
      ? position
      : this[kPosition];

    const bytesRead = await this[kHandle].read(buffer, offset, length, pos);

    // Update position if reading from current position
    if (position === null || position === undefined) {
      this[kPosition] += bytesRead;
    }

    return { bytesRead, buffer };
  }

  /**
   * Write data to file
   * @param {Buffer} buffer - Buffer to write from
   * @param {number} offset - Buffer offset
   * @param {number} length - Number of bytes to write
   * @param {number|null} position - File position (null = current)
   * @returns {Promise<{bytesWritten: number, buffer: Buffer}>}
   */
  async write(buffer, offset, length, position) {
    if (this[kClosed]) {
      throw EBADF('write');
    }

    // Handle write(string, position, encoding) signature
    if (typeof buffer === 'string') {
      const encoding = offset || 'utf8';
      buffer = Buffer.from(buffer, encoding);
      offset = 0;
      length = buffer.length;
      position = length;  // position was passed as second arg
    }

    // Validate arguments
    if (!Buffer.isBuffer(buffer)) {
      throw new TypeError('buffer must be a Buffer');
    }

    offset = offset || 0;
    length = length === undefined ? buffer.length - offset : length;

    const pos = position !== null && position !== undefined
      ? position
      : this[kPosition];

    const bytesWritten = await this[kHandle].write(buffer, offset, length, pos);

    // Update position if writing from current position
    if (position === null || position === undefined) {
      this[kPosition] += bytesWritten;
    }

    return { bytesWritten, buffer };
  }

  /**
   * Read entire file
   * @param {Object} options - Options { encoding }
   * @returns {Promise<string|Buffer>}
   */
  async readFile(options = {}) {
    if (this[kClosed]) {
      throw EBADF('readFile');
    }

    const encoding = options.encoding;
    const chunks = [];
    let totalLength = 0;

    // Reset to beginning
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;

    while (true) {
      const { bytesRead } = await this.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;

      chunks.push(buffer.subarray(0, bytesRead));
      totalLength += bytesRead;
      position += bytesRead;
    }

    const result = Buffer.concat(chunks, totalLength);
    return encoding ? result.toString(encoding) : result;
  }

  /**
   * Write data to file
   * @param {string|Buffer} data - Data to write
   * @param {Object} options - Options { encoding }
   * @returns {Promise<void>}
   */
  async writeFile(data, options = {}) {
    if (this[kClosed]) {
      throw EBADF('writeFile');
    }

    const encoding = options.encoding || 'utf8';
    const buffer = typeof data === 'string' ? Buffer.from(data, encoding) : data;

    // Truncate file first
    if (this[kHandle].truncate) {
      await this[kHandle].truncate(0);
    }

    let offset = 0;
    let position = 0;

    while (offset < buffer.length) {
      const { bytesWritten } = await this.write(
        buffer,
        offset,
        buffer.length - offset,
        position,
      );
      offset += bytesWritten;
      position += bytesWritten;
    }
  }

  /**
   * Append data to file
   * @param {string|Buffer} data - Data to append
   * @param {Object} options - Options { encoding }
   * @returns {Promise<void>}
   */
  async appendFile(data, options = {}) {
    if (this[kClosed]) {
      throw EBADF('appendFile');
    }

    const encoding = options.encoding || 'utf8';
    const buffer = typeof data === 'string' ? Buffer.from(data, encoding) : data;

    // Get file size to append at end
    const stats = await this.stat();
    let position = stats.size;

    let offset = 0;
    while (offset < buffer.length) {
      const { bytesWritten } = await this.write(
        buffer,
        offset,
        buffer.length - offset,
        position,
      );
      offset += bytesWritten;
      position += bytesWritten;
    }
  }

  /**
   * Get file stats
   * @param {Object} options - Options
   * @returns {Promise<VirtualStats>}
   */
  async stat(options = {}) {
    if (this[kClosed]) {
      throw EBADF('stat');
    }

    if (this[kHandle].stat) {
      return await this[kHandle].stat(options);
    }

    // Fallback to provider stat
    return await this[kProvider].stat(this[kPath], options);
  }

  /**
   * Truncate file
   * @param {number} len - New file length
   * @returns {Promise<void>}
   */
  async truncate(len = 0) {
    if (this[kClosed]) {
      throw EBADF('truncate');
    }

    if (this[kHandle].truncate) {
      return await this[kHandle].truncate(len);
    }

    throw new Error('Provider does not support truncate');
  }

  /**
   * Sync file to disk
   * @returns {Promise<void>}
   */
  async sync() {
    if (this[kClosed]) {
      throw EBADF('sync');
    }

    if (this[kHandle].sync) {
      return await this[kHandle].sync();
    }

    // No-op if not supported
  }

  /**
   * Sync data to disk
   * @returns {Promise<void>}
   */
  async datasync() {
    if (this[kClosed]) {
      throw EBADF('datasync');
    }

    if (this[kHandle].datasync) {
      return await this[kHandle].datasync();
    }

    // No-op if not supported
  }

  /**
   * Change file mode
   * @param {number} mode - New file mode
   * @returns {Promise<void>}
   */
  async chmod(mode) {
    if (this[kClosed]) {
      throw EBADF('chmod');
    }

    if (this[kHandle].chmod) {
      return await this[kHandle].chmod(mode);
    }

    // Fallback to provider chmod
    return await this[kProvider].chmod(this[kPath], mode);
  }

  /**
   * Change file ownership
   * @param {number} uid - User ID
   * @param {number} gid - Group ID
   * @returns {Promise<void>}
   */
  async chown(uid, gid) {
    if (this[kClosed]) {
      throw EBADF('chown');
    }

    if (this[kHandle].chown) {
      return await this[kHandle].chown(uid, gid);
    }

    // Fallback to provider chown
    return await this[kProvider].chown(this[kPath], uid, gid);
  }

  /**
   * Update file times
   * @param {number|Date} atime - Access time
   * @param {number|Date} mtime - Modification time
   * @returns {Promise<void>}
   */
  async utimes(atime, mtime) {
    if (this[kClosed]) {
      throw EBADF('utimes');
    }

    if (this[kHandle].utimes) {
      return await this[kHandle].utimes(atime, mtime);
    }

    // Fallback to provider utimes
    return await this[kProvider].utimes(this[kPath], atime, mtime);
  }

  /**
   * Create a read stream
   * @param {Object} options - Stream options
   * @returns {ReadStream}
   */
  createReadStream(options = {}) {
    // TODO: Implement when we add stream support in Phase 4
    throw new Error('createReadStream not yet implemented');
  }

  /**
   * Create a write stream
   * @param {Object} options - Stream options
   * @returns {WriteStream}
   */
  createWriteStream(options = {}) {
    // TODO: Implement when we add stream support in Phase 4
    throw new Error('createWriteStream not yet implemented');
  }

  /**
   * Close file handle
   * @returns {Promise<void>}
   */
  async close() {
    if (this[kFd] === -1) {
      return PromiseResolve();
    }

    if (this[kClosePromise]) {
      return this[kClosePromise];
    }

    this[kClosed] = true;
    this[kFd] = -1;

    const closePromise = this[kHandle].close
      ? this[kHandle].close()
      : Promise.resolve();

    this[kClosePromise] = closePromise.finally(() => {
      this[kClosePromise] = null;
      this.emit('close');
    });

    return this[kClosePromise];
  }

  /**
   * Create a readable stream from this file handle
   * @param {Object} options - Stream options
   * @returns {VirtualReadStream}
   */
  createReadStream(options) {
    const { VirtualReadStream } = require('internal/fs/vfs/streams');
    return new VirtualReadStream(null, this[kPath], { ...options, fd: this });
  }

  /**
   * Create a writable stream from this file handle
   * @param {Object} options - Stream options
   * @returns {VirtualWriteStream}
   */
  createWriteStream(options) {
    const { VirtualWriteStream } = require('internal/fs/vfs/streams');
    return new VirtualWriteStream(null, this[kPath], { ...options, fd: this });
  }

  /**
   * Async dispose (for using)
   * @returns {Promise<void>}
   */
  async [SymbolAsyncDispose]() {
    await this.close();
  }
}

// Sync version of file handle
class VirtualFileHandleSync {
  constructor(provider, path, flags, mode, handle) {
    this[kProvider] = provider;
    this[kPath] = path;
    this[kFlags] = flags;
    this[kMode] = mode;
    this[kHandle] = handle;
    this[kFd] = handle.fd || -1;
    this[kClosed] = false;
    this[kPosition] = 0;
  }

  get fd() {
    return this[kFd];
  }

  get path() {
    return this[kPath];
  }

  readSync(buffer, offset, length, position) {
    if (this[kClosed]) {
      throw EBADF('read');
    }

    offset = offset || 0;
    length = length === undefined ? buffer.length - offset : length;

    const pos = position !== null && position !== undefined
      ? position
      : this[kPosition];

    const bytesRead = this[kHandle].readSync(buffer, offset, length, pos);

    if (position === null || position === undefined) {
      this[kPosition] += bytesRead;
    }

    return bytesRead;
  }

  writeSync(buffer, offset, length, position) {
    if (this[kClosed]) {
      throw EBADF('write');
    }

    // Handle write(string, position, encoding) signature
    if (typeof buffer === 'string') {
      const encoding = offset || 'utf8';
      buffer = Buffer.from(buffer, encoding);
      offset = 0;
      length = buffer.length;
      position = length;
    }

    offset = offset || 0;
    length = length === undefined ? buffer.length - offset : length;

    const pos = position !== null && position !== undefined
      ? position
      : this[kPosition];

    const bytesWritten = this[kHandle].writeSync(buffer, offset, length, pos);

    if (position === null || position === undefined) {
      this[kPosition] += bytesWritten;
    }

    return bytesWritten;
  }

  closeSync() {
    if (this[kFd] === -1) {
      return;
    }

    this[kClosed] = true;
    this[kFd] = -1;

    if (this[kHandle].closeSync) {
      this[kHandle].closeSync();
    }
  }
}

module.exports = {
  VirtualFileHandle,
  VirtualFileHandleSync,
};
