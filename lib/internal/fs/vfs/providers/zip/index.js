'use strict';

const pathModule = require('path');
const { Buffer } = require('buffer');
const zlib = require('zlib');
const { VirtualProvider } = require('internal/fs/vfs/provider');
const { createVirtualStats } = require('internal/fs/vfs/stats');
const { createVirtualDirent } = require('internal/fs/vfs/dirent');
const { ENOENT, ENOTDIR, ENOTEMPTY, ReadOnlyError } = require('internal/fs/vfs/errors');

const {
  S_IFREG,
  S_IFDIR,
} = internalBinding('constants').fs;

/**
 * Simple ZIP format implementation
 * This is a minimal implementation for demonstration
 * A full ZIP library would handle more edge cases
 */
class SimpleZipReader {
  constructor(buffer) {
    this.buffer = buffer;
    this.entries = new Map();
    this._parse();
  }

  _parse() {
    // Look for End of Central Directory (EOCD) signature
    // In a real implementation, we'd properly parse the ZIP format
    // For now, this is a simplified version

    // ZIP files have entries with local file headers
    // followed by a central directory at the end
    // This is a simplified parser that assumes well-formed ZIP

    let offset = 0;
    const LOCAL_FILE_HEADER_SIG = 0x04034b50;

    while (offset < this.buffer.length - 30) {
      const sig = this.buffer.readUInt32LE(offset);

      if (sig !== LOCAL_FILE_HEADER_SIG) {
        break;
      }

      // Parse local file header
      const version = this.buffer.readUInt16LE(offset + 4);
      const flags = this.buffer.readUInt16LE(offset + 6);
      const compressionMethod = this.buffer.readUInt16LE(offset + 8);
      const compressedSize = this.buffer.readUInt32LE(offset + 18);
      const uncompressedSize = this.buffer.readUInt32LE(offset + 22);
      const fileNameLength = this.buffer.readUInt16LE(offset + 26);
      const extraFieldLength = this.buffer.readUInt16LE(offset + 28);

      offset += 30;

      const fileName = this.buffer.toString('utf8', offset, offset + fileNameLength);
      offset += fileNameLength + extraFieldLength;

      const compressedData = this.buffer.subarray(offset, offset + compressedSize);
      offset += compressedSize;

      // Store entry
      this.entries.set(fileName, {
        fileName,
        compressionMethod,
        compressedSize,
        uncompressedSize,
        compressedData,
      });
    }
  }

  getEntry(fileName) {
    return this.entries.get(fileName);
  }

  extractEntry(fileName) {
    const entry = this.entries.get(fileName);
    if (!entry) return null;

    if (entry.compressionMethod === 0) {
      // No compression
      return entry.compressedData;
    } else if (entry.compressionMethod === 8) {
      // DEFLATE compression
      return zlib.inflateRawSync(entry.compressedData);
    }

    throw new Error(`Unsupported compression method: ${entry.compressionMethod}`);
  }

  getAllEntries() {
    return Array.from(this.entries.keys());
  }
}

/**
 * ZipProvider - Provider for reading/writing ZIP archives
 *
 * Features:
 * - Read from existing ZIP archives
 * - Write mode with pending changes pattern
 * - Auto-flush or manual flush
 * - Directory structure tracking
 *
 * Limitations:
 * - Simplified ZIP format support
 * - No compression level control
 * - No advanced ZIP features (encryption, ZIP64, etc.)
 */
class ZipProvider extends VirtualProvider {
  constructor(buffer, options = {}) {
    super();

    this._readonly = options.readonly || false;
    this._autoFlush = options.autoFlush || false;
    this._modified = false;

    // Parse existing ZIP if buffer provided
    if (buffer && buffer.length > 0) {
      this._zip = new SimpleZipReader(buffer);
      this._entries = new Map(this._zip.entries);
    } else {
      this._zip = null;
      this._entries = new Map();
    }

    this._dirs = new Set(['/']);
    this._buildIndex();

    // Pending changes (write mode)
    this._pendingFiles = new Map();
    this._pendingDirs = new Set();
    this._deletedFiles = new Set();
    this._deletedDirs = new Set();
  }

  _buildIndex() {
    // Build directory structure from entries
    for (const fileName of this._entries.keys()) {
      const normalized = this._normalizePath(fileName);

      if (fileName.endsWith('/')) {
        this._dirs.add(normalized.replace(/\/$/, ''));
      } else {
        this._addParentDirs(pathModule.dirname(normalized));
      }
    }
  }

  _addParentDirs(path) {
    const parts = path.split('/').filter((p) => p);
    let current = '';

    for (const part of parts) {
      current += `/${part}`;
      this._dirs.add(current);
    }

    this._dirs.add('/');
  }

  _normalizePath(path) {
    let normalized = pathModule.normalize(path).replace(/\\/g, '/');
    if (!normalized.startsWith('/')) normalized = '/' + normalized;
    return normalized === '' ? '/' : normalized;
  }

  /**
   * Flush pending changes to create new ZIP buffer
   */
  flush() {
    if (!this._modified) return this._getCurrentBuffer();

    // Combine original entries with pending changes
    const allEntries = new Map();

    // Add original entries (excluding deleted)
    for (const [path, entry] of this._entries) {
      const normalized = this._normalizePath(path);
      if (!this._deletedFiles.has(normalized)) {
        allEntries.set(normalized, entry);
      }
    }

    // Add pending files
    for (const [path, content] of this._pendingFiles) {
      allEntries.set(path, { content });
    }

    // Create new ZIP buffer
    return this._createZipBuffer(allEntries);
  }

  _getCurrentBuffer() {
    if (!this._zip) return Buffer.allocUnsafe(0);
    return this._zip.buffer;
  }

  _createZipBuffer(entries) {
    // Simple ZIP creation
    // In a full implementation, this would properly format ZIP structure
    const chunks = [];
    let offset = 0;
    const centralDirectory = [];

    for (const [fileName, entry] of entries) {
      const relativeFileName = fileName.startsWith('/') ? fileName.slice(1) : fileName;
      const fileNameBuf = Buffer.from(relativeFileName, 'utf8');

      let data;
      if (entry.content) {
        data = entry.content;
      } else if (entry.compressedData) {
        data = this._zip ? this._zip.extractEntry(entry.fileName) : Buffer.allocUnsafe(0);
      } else {
        data = Buffer.allocUnsafe(0);
      }

      // Compress data
      const compressed = zlib.deflateRawSync(data);

      // Local file header
      const localHeader = Buffer.allocUnsafe(30);
      localHeader.writeUInt32LE(0x04034b50, 0); // Signature
      localHeader.writeUInt16LE(20, 4); // Version
      localHeader.writeUInt16LE(0, 6); // Flags
      localHeader.writeUInt16LE(8, 8); // Compression method (DEFLATE)
      localHeader.writeUInt16LE(0, 10); // Mod time
      localHeader.writeUInt16LE(0, 12); // Mod date
      localHeader.writeUInt32LE(0, 14); // CRC-32 (simplified)
      localHeader.writeUInt32LE(compressed.length, 18); // Compressed size
      localHeader.writeUInt32LE(data.length, 22); // Uncompressed size
      localHeader.writeUInt16LE(fileNameBuf.length, 26); // Filename length
      localHeader.writeUInt16LE(0, 28); // Extra field length

      chunks.push(localHeader, fileNameBuf, compressed);

      // Track for central directory
      centralDirectory.push({
        fileName: relativeFileName,
        fileNameBuf,
        offset,
        compressedSize: compressed.length,
        uncompressedSize: data.length,
      });

      offset += localHeader.length + fileNameBuf.length + compressed.length;
    }

    // Central directory
    const centralDirStart = offset;
    for (const entry of centralDirectory) {
      const cdHeader = Buffer.allocUnsafe(46);
      cdHeader.writeUInt32LE(0x02014b50, 0); // Central dir signature
      cdHeader.writeUInt16LE(20, 4); // Version made by
      cdHeader.writeUInt16LE(20, 6); // Version needed
      cdHeader.writeUInt16LE(0, 8); // Flags
      cdHeader.writeUInt16LE(8, 10); // Compression method
      cdHeader.writeUInt16LE(0, 12); // Mod time
      cdHeader.writeUInt16LE(0, 14); // Mod date
      cdHeader.writeUInt32LE(0, 16); // CRC-32
      cdHeader.writeUInt32LE(entry.compressedSize, 20); // Compressed size
      cdHeader.writeUInt32LE(entry.uncompressedSize, 24); // Uncompressed size
      cdHeader.writeUInt16LE(entry.fileNameBuf.length, 28); // Filename length
      cdHeader.writeUInt16LE(0, 30); // Extra field length
      cdHeader.writeUInt16LE(0, 32); // File comment length
      cdHeader.writeUInt16LE(0, 34); // Disk number
      cdHeader.writeUInt16LE(0, 36); // Internal attrs
      cdHeader.writeUInt32LE(0, 38); // External attrs
      cdHeader.writeUInt32LE(entry.offset, 42); // Local header offset

      chunks.push(cdHeader, entry.fileNameBuf);
      offset += cdHeader.length + entry.fileNameBuf.length;
    }

    // End of central directory
    const eocd = Buffer.allocUnsafe(22);
    eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
    eocd.writeUInt16LE(0, 4); // Disk number
    eocd.writeUInt16LE(0, 6); // Central dir disk
    eocd.writeUInt16LE(centralDirectory.length, 8); // Entries on this disk
    eocd.writeUInt16LE(centralDirectory.length, 10); // Total entries
    eocd.writeUInt32LE(offset - centralDirStart, 12); // Central dir size
    eocd.writeUInt32LE(centralDirStart, 16); // Central dir offset
    eocd.writeUInt16LE(0, 20); // Comment length

    chunks.push(eocd);

    return Buffer.concat(chunks);
  }

  // === CAPABILITY OVERRIDES ===

  get readonly() {
    return this._readonly;
  }

  get supportsSymlinks() {
    return false;
  }

  get supportsHardLinks() {
    return false;
  }

  get supportsPermissions() {
    return false;
  }

  get supportsChown() {
    return false;
  }

  get supportsTempDirectory() {
    return false;
  }

  // === PRIMITIVES ===

  async open(path, flags, mode) {
    return this.openSync(path, flags, mode);
  }

  openSync(path, flags, mode) {
    const key = this._normalizePath(path);
    const isWrite = (flags & 3) !== 0;

    if (isWrite && this._readonly) {
      throw new ReadOnlyError('open', key);
    }

    if (isWrite) {
      // Return writable handle
      const existing = this._getFileContent(key);
      return new ZipWriteHandle(this, key, existing);
    } else {
      // Return readable handle
      const content = this._getFileContent(key);
      if (!content) throw ENOENT('open', path);
      return new ZipReadHandle(content);
    }
  }

  _getFileContent(path) {
    // Check pending first
    if (this._pendingFiles.has(path)) {
      return this._pendingFiles.get(path);
    }

    // Check original ZIP
    if (this._zip) {
      const relPath = path.startsWith('/') ? path.slice(1) : path;
      return this._zip.extractEntry(relPath);
    }

    return null;
  }

  async stat(path, options = {}) {
    return this.statSync(path, options);
  }

  statSync(path, options = {}) {
    const key = this._normalizePath(path);

    // Check if deleted
    if (this._deletedFiles.has(key) || this._deletedDirs.has(key)) {
      throw ENOENT('stat', path);
    }

    // Check if directory
    if (this._dirs.has(key) || this._pendingDirs.has(key)) {
      return createVirtualStats({
        dev: 0,
        mode: S_IFDIR | 0o755,
        nlink: 1,
        size: 0,
      });
    }

    // Check if file
    const content = this._getFileContent(key);
    if (content) {
      return createVirtualStats({
        dev: 0,
        mode: S_IFREG | 0o644,
        nlink: 1,
        size: content.length,
      });
    }

    throw ENOENT('stat', path);
  }

  async unlink(path) {
    return this.unlinkSync(path);
  }

  unlinkSync(path) {
    if (this._readonly) throw new ReadOnlyError('unlink', path);

    const key = this._normalizePath(path);

    if (!this._getFileContent(key)) {
      throw ENOENT('unlink', path);
    }

    this._deletedFiles.add(key);
    this._pendingFiles.delete(key);
    this._modified = true;

    if (this._autoFlush) this.flush();
  }

  async rename(oldPath, newPath) {
    return this.renameSync(oldPath, newPath);
  }

  renameSync(oldPath, newPath) {
    if (this._readonly) throw new ReadOnlyError('rename', oldPath);

    const oldKey = this._normalizePath(oldPath);
    const newKey = this._normalizePath(newPath);

    const content = this._getFileContent(oldKey);
    if (!content) throw ENOENT('rename', oldPath);

    this._pendingFiles.set(newKey, content);
    this._deletedFiles.add(oldKey);
    this._pendingFiles.delete(oldKey);
    this._modified = true;

    if (this._autoFlush) this.flush();
  }

  async chmod(path, mode) {
    // No-op for ZIP
  }

  chmodSync(path, mode) {
    // No-op for ZIP
  }

  async chown(path, uid, gid) {
    // No-op for ZIP
  }

  chownSync(path, uid, gid) {
    // No-op for ZIP
  }

  async utimes(path, atime, mtime) {
    // No-op for ZIP
  }

  utimesSync(path, atime, mtime) {
    // No-op for ZIP
  }

  async link(existingPath, newPath) {
    throw new Error('ZIP does not support hard links');
  }

  linkSync(existingPath, newPath) {
    throw new Error('ZIP does not support hard links');
  }

  async symlink(target, path, type) {
    throw new Error('ZIP does not support symbolic links');
  }

  symlinkSync(target, path, type) {
    throw new Error('ZIP does not support symbolic links');
  }

  async readlink(path) {
    throw new Error('ZIP does not support symbolic links');
  }

  readlinkSync(path) {
    throw new Error('ZIP does not support symbolic links');
  }

  async mkdir(path, options = {}) {
    return this.mkdirSync(path, options);
  }

  mkdirSync(path, options = {}) {
    if (this._readonly) throw new ReadOnlyError('mkdir', path);

    const key = this._normalizePath(path);

    if (this._dirs.has(key) || this._pendingDirs.has(key)) {
      if (!options.recursive) {
        throw new Error('Directory already exists');
      }
      return undefined;
    }

    this._pendingDirs.add(key);
    this._dirs.add(key);
    this._modified = true;

    if (this._autoFlush) this.flush();
    return undefined;
  }

  async rmdir(path) {
    return this.rmdirSync(path);
  }

  rmdirSync(path) {
    if (this._readonly) throw new ReadOnlyError('rmdir', path);

    const key = this._normalizePath(path);

    if (!this._dirs.has(key) && !this._pendingDirs.has(key)) {
      throw ENOENT('rmdir', path);
    }

    // Check if empty
    const children = this._getChildren(key);
    if (children.length > 0) {
      throw ENOTEMPTY('rmdir', path);
    }

    this._deletedDirs.add(key);
    this._pendingDirs.delete(key);
    this._dirs.delete(key);
    this._modified = true;

    if (this._autoFlush) this.flush();
  }

  async readdir(path, options = {}) {
    return this.readdirSync(path, options);
  }

  readdirSync(path, options = {}) {
    const key = this._normalizePath(path);

    if (!this._dirs.has(key) && !this._pendingDirs.has(key)) {
      throw ENOTDIR('readdir', path);
    }

    const children = this._getChildren(key);

    if (options.withFileTypes) {
      return children.map((name) => {
        const childPath = pathModule.join(key, name);
        const stats = this.statSync(childPath);
        return createVirtualDirent(name, stats, key);
      });
    }

    return children;
  }

  _getChildren(dirPath) {
    const children = new Set();
    const prefix = dirPath === '/' ? '/' : `${dirPath}/`;

    // Check all entries
    for (const fileName of this._entries.keys()) {
      const normalized = this._normalizePath(fileName);
      if (this._deletedFiles.has(normalized)) continue;

      if (normalized.startsWith(prefix)) {
        const relative = normalized.slice(prefix.length);
        const firstPart = relative.split('/')[0];
        if (firstPart) children.add(firstPart);
      }
    }

    // Check pending files
    for (const filePath of this._pendingFiles.keys()) {
      if (this._deletedFiles.has(filePath)) continue;

      if (filePath.startsWith(prefix)) {
        const relative = filePath.slice(prefix.length);
        const firstPart = relative.split('/')[0];
        if (firstPart) children.add(firstPart);
      }
    }

    // Check subdirectories
    for (const dir of this._dirs) {
      if (this._deletedDirs.has(dir)) continue;

      if (dir.startsWith(prefix) && dir !== dirPath) {
        const relative = dir.slice(prefix.length);
        const firstPart = relative.split('/')[0];
        if (firstPart) children.add(firstPart);
      }
    }

    return Array.from(children);
  }

  tmpdir() {
    throw new Error('ZIP does not support temp directories');
  }

  // === HELPER FOR STORING FILES ===

  _storePendingFile(path, content) {
    this._pendingFiles.set(path, content);
    this._modified = true;

    if (this._autoFlush) {
      return this.flush();
    }
  }
}

// Read-only handle
class ZipReadHandle {
  constructor(content) {
    this.content = content;
    this.position = 0;
    this.closed = false;
    this.fd = -1;
  }

  async read(buffer, offset, length, position) {
    return this.readSync(buffer, offset, length, position);
  }

  readSync(buffer, offset, length, position) {
    if (this.closed) throw new Error('File handle closed');

    const pos = position !== null && position !== undefined ? position : this.position;
    const available = this.content.length - pos;
    const toRead = Math.min(length, available);

    if (toRead <= 0) return 0;

    this.content.copy(buffer, offset, pos, pos + toRead);

    if (position === null || position === undefined) {
      this.position += toRead;
    }

    return toRead;
  }

  async close() {
    this.closed = true;
  }

  closeSync() {
    this.closed = true;
  }
}

// Write handle
class ZipWriteHandle {
  constructor(provider, path, existingContent) {
    this.provider = provider;
    this.path = path;
    this.buffer = existingContent ? Buffer.from(existingContent) : Buffer.allocUnsafe(0);
    this.position = 0;
    this.closed = false;
    this.fd = -1;
  }

  async write(buffer, offset, length, position) {
    return this.writeSync(buffer, offset, length, position);
  }

  writeSync(buffer, offset, length, position) {
    if (this.closed) throw new Error('File handle closed');

    const pos = position !== null && position !== undefined ? position : this.position;
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
    return this.closeSync();
  }

  closeSync() {
    if (this.closed) return;
    this.closed = true;
    this.provider._storePendingFile(this.path, this.buffer);
  }
}

module.exports = { ZipProvider };
