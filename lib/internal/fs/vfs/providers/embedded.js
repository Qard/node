'use strict';

const pathModule = require('path');
const { Buffer } = require('buffer');
const { VirtualProvider } = require('internal/fs/vfs/provider');
const { createVirtualStats } = require('internal/fs/vfs/stats');
const { createVirtualDirent } = require('internal/fs/vfs/dirent');
const { ENOENT, ENOTDIR, ReadOnlyError } = require('internal/fs/vfs/errors');

const {
  S_IFREG,
  S_IFDIR,
} = internalBinding('constants').fs;

// Try to load sea module (may not be available)
let sea;
try {
  sea = require('node:sea');
} catch {
  sea = null;
}

// Read-only file handle for embedded assets
class EmbeddedFileHandle {
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

/**
 * EmbeddedProvider - Read-only access to SEA (Single Executable Application) embedded assets
 *
 * Features:
 * - Read-only access to assets embedded in Node.js SEA executables
 * - Uses node:sea APIs (getAsset, getRawAsset, getAssetKeys)
 * - Builds directory structure from flat asset keys
 * - No external dependencies
 *
 * Limitations:
 * - Read-only (no write operations)
 * - No symlinks or hard links
 * - No permissions or ownership
 * - Requires Node.js SEA support
 *
 * Example:
 * ```javascript
 * // After building SEA with assets embedded:
 * const provider = new EmbeddedProvider();
 * const content = await provider.readFile('/assets/config.json', 'utf8');
 * ```
 */
class EmbeddedProvider extends VirtualProvider {
  constructor(options = {}) {
    super();

    if (!sea || !sea.isSea()) {
      throw new Error('EmbeddedProvider requires Node.js SEA environment');
    }

    this._prefix = options.prefix || '';
    this._assets = new Map();
    this._dirs = new Set(['/']);

    this._buildIndex();
  }

  _buildIndex() {
    // Get all asset keys from SEA
    const assetKeys = sea.getAssetAsBlob ? this._getAssetKeysFromBlob() : sea.getAssetKeys?.() || [];

    for (const key of assetKeys) {
      // Normalize key to path
      const normalizedKey = this._normalizeKey(key);

      // Store asset
      this._assets.set(normalizedKey, key);

      // Build directory structure
      this._addParentDirs(pathModule.dirname(normalizedKey));
    }
  }

  _getAssetKeysFromBlob() {
    // Fallback for older SEA implementations
    // In newer versions, there should be a direct API
    // This is a simplified approach
    return [];
  }

  _normalizeKey(key) {
    // Remove prefix if present
    if (this._prefix && key.startsWith(this._prefix)) {
      key = key.slice(this._prefix.length);
    }

    // Normalize to absolute path
    let normalized = pathModule.normalize(key).replace(/\\/g, '/');
    if (!normalized.startsWith('/')) normalized = '/' + normalized;

    return normalized;
  }

  _addParentDirs(path) {
    if (!path || path === '/') return;

    const parts = path.split('/').filter((p) => p);
    let current = '';

    for (const part of parts) {
      current += `/${part}`;
      this._dirs.add(current);
    }
  }

  _normalizePath(path) {
    return pathModule.normalize(path).replace(/\\/g, '/');
  }

  _getAssetContent(key) {
    const assetKey = this._assets.get(key);
    if (!assetKey) return null;

    try {
      // Try getRawAsset first (returns Buffer)
      if (sea.getRawAsset) {
        return sea.getRawAsset(assetKey);
      }

      // Fallback to getAsset (returns string)
      if (sea.getAsset) {
        const content = sea.getAsset(assetKey);
        return Buffer.from(content, 'utf8');
      }

      return null;
    } catch {
      return null;
    }
  }

  // === CAPABILITY OVERRIDES ===

  get readonly() {
    return true;
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

  get supportsUtime() {
    return false;
  }

  // === PRIMITIVES ===

  async open(path, flags, mode) {
    return this.openSync(path, flags, mode);
  }

  openSync(path, flags, mode) {
    const isWrite = (flags & 3) !== 0;

    if (isWrite) {
      throw new ReadOnlyError('open', path);
    }

    const key = this._normalizePath(path);
    const content = this._getAssetContent(key);

    if (!content) {
      throw ENOENT('open', path);
    }

    return new EmbeddedFileHandle(content);
  }

  async stat(path, options = {}) {
    return this.statSync(path, options);
  }

  statSync(path, options = {}) {
    const key = this._normalizePath(path);

    // Check if directory
    if (this._dirs.has(key)) {
      return createVirtualStats({
        dev: 0,
        mode: S_IFDIR | 0o755,
        nlink: 1,
        size: 0,
      });
    }

    // Check if file
    const content = this._getAssetContent(key);
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
    throw new ReadOnlyError('unlink', path);
  }

  unlinkSync(path) {
    throw new ReadOnlyError('unlink', path);
  }

  async rename(oldPath, newPath) {
    throw new ReadOnlyError('rename', oldPath);
  }

  renameSync(oldPath, newPath) {
    throw new ReadOnlyError('rename', oldPath);
  }

  async chmod(path, mode) {
    // No-op for embedded assets
  }

  chmodSync(path, mode) {
    // No-op for embedded assets
  }

  async chown(path, uid, gid) {
    // No-op for embedded assets
  }

  chownSync(path, uid, gid) {
    // No-op for embedded assets
  }

  async utimes(path, atime, mtime) {
    // No-op for embedded assets
  }

  utimesSync(path, atime, mtime) {
    // No-op for embedded assets
  }

  async link(existingPath, newPath) {
    throw new ReadOnlyError('link', existingPath);
  }

  linkSync(existingPath, newPath) {
    throw new ReadOnlyError('link', existingPath);
  }

  async symlink(target, path, type) {
    throw new ReadOnlyError('symlink', path);
  }

  symlinkSync(target, path, type) {
    throw new ReadOnlyError('symlink', path);
  }

  async readlink(path) {
    throw new Error('Embedded assets do not support symbolic links');
  }

  readlinkSync(path) {
    throw new Error('Embedded assets do not support symbolic links');
  }

  async mkdir(path, options = {}) {
    throw new ReadOnlyError('mkdir', path);
  }

  mkdirSync(path, options = {}) {
    throw new ReadOnlyError('mkdir', path);
  }

  async rmdir(path) {
    throw new ReadOnlyError('rmdir', path);
  }

  rmdirSync(path) {
    throw new ReadOnlyError('rmdir', path);
  }

  async readdir(path, options = {}) {
    return this.readdirSync(path, options);
  }

  readdirSync(path, options = {}) {
    const key = this._normalizePath(path);

    if (!this._dirs.has(key)) {
      throw ENOTDIR('readdir', path);
    }

    const entries = new Set();
    const prefix = key === '/' ? '/' : `${key}/`;

    // Find all direct children
    for (const assetPath of this._assets.keys()) {
      if (assetPath.startsWith(prefix)) {
        const relative = assetPath.slice(prefix.length);
        const firstPart = relative.split('/')[0];
        if (firstPart) entries.add(firstPart);
      }
    }

    // Find subdirectories
    for (const dir of this._dirs) {
      if (dir.startsWith(prefix) && dir !== key) {
        const relative = dir.slice(prefix.length);
        const firstPart = relative.split('/')[0];
        if (firstPart) entries.add(firstPart);
      }
    }

    const result = Array.from(entries);

    if (options.withFileTypes) {
      return result.map((name) => {
        const childPath = pathModule.join(key, name);
        const stats = this.statSync(childPath);
        return createVirtualDirent(name, stats, key);
      });
    }

    return result;
  }

  tmpdir() {
    throw new Error('Embedded assets do not support temp directories');
  }
}

module.exports = { EmbeddedProvider };
