'use strict';

const pathModule = require('path');
const { Buffer } = require('buffer');
const { VirtualProvider } = require('internal/fs/vfs/provider');
const { createVirtualStats } = require('internal/fs/vfs/stats');
const { S3Client } = require('internal/fs/vfs/providers/s3/client');
const { ENOENT, ENOTDIR } = require('internal/fs/vfs/errors');

const {
  S_IFREG,
  S_IFDIR,
} = internalBinding('constants').fs;

// S3 file handle for reading
class S3FileHandle {
  constructor(client, key, size) {
    this.client = client;
    this.key = key;
    this.size = size;
    this.position = 0;
    this.closed = false;
    this.fd = -1;
  }

  async read(buffer, offset, length, position) {
    if (this.closed) throw new Error('File handle closed');

    const pos = position !== null && position !== undefined ? position : this.position;
    const endPos = Math.min(pos + length, this.size);
    const toRead = endPos - pos;

    if (toRead <= 0) return 0;

    // Use Range GET to read specific bytes
    const response = await this.client.getObjectRange(this.key, pos, endPos - 1);
    const bytesRead = response.body.copy(buffer, offset, 0, response.body.length);

    if (position === null || position === undefined) {
      this.position += bytesRead;
    }

    return bytesRead;
  }

  async write(buffer, offset, length, position) {
    throw new Error('S3 file handle does not support write (reopen in write mode)');
  }

  async close() {
    this.closed = true;
  }

  closeSync() {
    this.closed = true;
  }
}

// S3 file handle for writing
class S3WriteHandle {
  constructor(client, key, mode) {
    this.client = client;
    this.key = key;
    this.mode = mode;
    this.buffer = Buffer.allocUnsafe(0);
    this.position = 0;
    this.closed = false;
    this.fd = -1;
  }

  async read(buffer, offset, length, position) {
    throw new Error('S3 write handle does not support read');
  }

  async write(buffer, offset, length, position) {
    if (this.closed) throw new Error('File handle closed');

    const pos = position !== null && position !== undefined ? position : this.position;

    // Extend buffer if needed
    const endPos = pos + length;
    if (endPos > this.buffer.length) {
      const newBuffer = Buffer.allocUnsafe(endPos);
      this.buffer.copy(newBuffer, 0, 0, this.buffer.length);
      this.buffer = newBuffer;
    }

    buffer.copy(this.buffer, pos, offset, offset + length);

    if (position === null || position === undefined) {
      this.position += length;
    }

    return length;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;

    // Upload to S3
    await this.client.putObject(this.key, this.buffer);
  }

  closeSync() {
    throw new Error('S3 write handle does not support sync close (use async)');
  }
}

/**
 * S3Provider - Provider for Amazon S3 and S3-compatible storage
 *
 * Features:
 * - Streaming reads with Range GET
 * - Efficient server-side copy
 * - Optional metadata storage for permissions/times
 *
 * Limitations:
 * - No symlinks or hard links
 * - Rename is not atomic (copy + delete)
 * - Permissions only work with storeMetadata=true
 */
class S3Provider extends VirtualProvider {
  constructor(options) {
    super();

    this.client = new S3Client(options);
    this.storeMetadata = options.storeMetadata || false;
    this.readBufferSize = options.readBufferSize || 256 * 1024;
  }

  // === CAPABILITY OVERRIDES ===

  get supportsSymlinks() {
    return false;
  }

  get supportsHardLinks() {
    return false;
  }

  get supportsPermissions() {
    return this.storeMetadata;
  }

  get supportsUtime() {
    return this.storeMetadata;
  }

  get deleteRaisesOnMissing() {
    return false; // S3 delete is idempotent
  }

  get mkdirRaisesOnExists() {
    return false; // S3 mkdir is idempotent
  }

  // === PRIMITIVES ===

  async open(path, flags, mode) {
    const key = this._normalizeKey(path);

    // For simplicity, determine read vs write from flags
    const isRead = (flags & 3) === 0; // O_RDONLY
    const isWrite = (flags & 3) !== 0; // O_WRONLY or O_RDWR

    if (isRead) {
      const size = await this.client.getObjectSize(key);
      if (size === null) throw ENOENT('open', path);
      return new S3FileHandle(this.client, key, size);
    } else {
      return new S3WriteHandle(this.client, key, mode);
    }
  }

  openSync(path, flags, mode) {
    throw new Error('S3Provider does not support sync operations');
  }

  async stat(path, options = {}) {
    const key = this._normalizeKey(path);

    // Check if it's a directory
    if (key.endsWith('/') || await this._isDirectory(key)) {
      return createVirtualStats({
        dev: 0,
        mode: S_IFDIR | 0o755,
        nlink: 1,
        uid: 0,
        gid: 0,
        size: 0,
      });
    }

    // HEAD object
    try {
      const response = await this.client.headObject(key);
      const size = parseInt(response.headers['content-length'], 10);

      // Parse metadata
      const mtime = this._parseTime(
        response.headers['x-amz-meta-vfs-mtime'] ||
        response.headers['last-modified'],
      );
      const permissions = this._parsePermissions(
        response.headers['x-amz-meta-vfs-permissions'],
      );

      return createVirtualStats({
        dev: 0,
        mode: S_IFREG | permissions,
        nlink: 1,
        uid: 0,
        gid: 0,
        size,
        mtimeMs: mtime,
        atimeMs: mtime,
        ctimeMs: mtime,
        birthtimeMs: mtime,
      });
    } catch (err) {
      if (err.statusCode === 404) {
        throw ENOENT('stat', path);
      }
      throw err;
    }
  }

  statSync(path, options = {}) {
    throw new Error('S3Provider does not support sync operations');
  }

  async unlink(path) {
    const key = this._normalizeKey(path);
    await this.client.deleteObject(key);
  }

  unlinkSync(path) {
    throw new Error('S3Provider does not support sync operations');
  }

  async rename(oldPath, newPath) {
    const oldKey = this._normalizeKey(oldPath);
    const newKey = this._normalizeKey(newPath);

    // Server-side copy
    await this.client.copyObject(oldKey, newKey);

    // Delete old object
    await this.client.deleteObject(oldKey);
  }

  renameSync(oldPath, newPath) {
    throw new Error('S3Provider does not support sync operations');
  }

  async chmod(path, mode) {
    if (!this.storeMetadata) return;

    const key = this._normalizeKey(path);

    // Copy to itself with new metadata
    await this.client.copyObject(key, key, {
      metadata: {
        'vfs-permissions': String(mode),
      },
    });
  }

  chmodSync(path, mode) {
    throw new Error('S3Provider does not support sync operations');
  }

  async chown(path, uid, gid) {
    // No-op for S3
  }

  chownSync(path, uid, gid) {
    // No-op for S3
  }

  async utimes(path, atime, mtime) {
    if (!this.storeMetadata) return;

    const key = this._normalizeKey(path);
    const mtimeMs = mtime instanceof Date ? mtime.getTime() : mtime;

    // Copy to itself with new metadata
    await this.client.copyObject(key, key, {
      metadata: {
        'vfs-mtime': String(Math.floor(mtimeMs / 1000)),
      },
    });
  }

  utimesSync(path, atime, mtime) {
    throw new Error('S3Provider does not support sync operations');
  }

  async link(existingPath, newPath) {
    throw new Error('S3 does not support hard links');
  }

  linkSync(existingPath, newPath) {
    throw new Error('S3 does not support hard links');
  }

  async symlink(target, path, type) {
    throw new Error('S3 does not support symbolic links');
  }

  symlinkSync(target, path, type) {
    throw new Error('S3 does not support symbolic links');
  }

  async readlink(path) {
    throw new Error('S3 does not support symbolic links');
  }

  readlinkSync(path) {
    throw new Error('S3 does not support symbolic links');
  }

  async mkdir(path, options = {}) {
    const key = this._normalizeKey(path);

    // Create a directory marker object (zero-byte object with trailing /)
    const dirKey = key.endsWith('/') ? key : `${key}/`;
    await this.client.putObject(dirKey, Buffer.allocUnsafe(0));

    return undefined;
  }

  mkdirSync(path, options = {}) {
    throw new Error('S3Provider does not support sync operations');
  }

  async rmdir(path) {
    const key = this._normalizeKey(path);

    // Check if directory is empty
    const { objects } = await this.client.listObjects(key, '/');
    if (objects.length > 1) { // > 1 because directory marker itself counts
      throw new Error('Directory not empty');
    }

    // Delete directory marker
    const dirKey = key.endsWith('/') ? key : `${key}/`;
    await this.client.deleteObject(dirKey);
  }

  rmdirSync(path) {
    throw new Error('S3Provider does not support sync operations');
  }

  async readdir(path, options = {}) {
    const key = this._normalizeKey(path);
    const prefix = key.endsWith('/') ? key : `${key}/`;

    const { objects, commonPrefixes } = await this.client.listObjects(prefix, '/');

    const entries = [];

    // Add directories
    for (const dirPrefix of commonPrefixes) {
      const name = dirPrefix.slice(prefix.length).replace(/\/$/, '');
      if (name) entries.push(name);
    }

    // Add files
    for (const obj of objects) {
      const name = obj.key.slice(prefix.length);
      if (name && !name.endsWith('/')) {
        entries.push(name);
      }
    }

    if (options.withFileTypes) {
      // Return dirents
      const { createVirtualDirent } = require('internal/fs/vfs/dirent');
      return entries.map((name) => {
        const isDir = commonPrefixes.some((p) =>
          p.slice(prefix.length).replace(/\/$/, '') === name,
        );
        const mode = isDir ? S_IFDIR | 0o755 : S_IFREG | 0o644;
        const stats = createVirtualStats({ mode });
        return createVirtualDirent(name, stats, key);
      });
    }

    return entries;
  }

  readdirSync(path, options = {}) {
    throw new Error('S3Provider does not support sync operations');
  }

  tmpdir() {
    throw new Error('S3 does not support temp directories');
  }

  // === HELPER METHODS ===

  _normalizeKey(path) {
    // Remove leading slash for S3 keys
    let key = pathModule.normalize(path).replace(/\\/g, '/');
    if (key.startsWith('/')) key = key.slice(1);
    return key;
  }

  async _isDirectory(key) {
    const prefix = key.endsWith('/') ? key : `${key}/`;
    try {
      const { objects, commonPrefixes } = await this.client.listObjects(prefix, '/');
      return objects.length > 0 || commonPrefixes.length > 0;
    } catch {
      return false;
    }
  }

  _parseTime(timeStr) {
    if (!timeStr) return Date.now();

    // Check if it's a unix timestamp
    if (/^\d+$/.test(timeStr)) {
      return parseInt(timeStr, 10) * 1000;
    }

    // Parse HTTP date
    return new Date(timeStr).getTime();
  }

  _parsePermissions(permStr) {
    if (!permStr) return 0o644;
    return parseInt(permStr, 10);
  }
}

module.exports = { S3Provider };
