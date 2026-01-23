'use strict';

const pathModule = require('path');
const { VirtualProvider } = require('internal/fs/vfs/provider');
const { ENOENT } = require('internal/fs/vfs/errors');

/**
 * OverlayProvider - Union filesystem with copy-on-write semantics
 *
 * Implements a classic overlay/union filesystem where:
 * - Writes go to upper (writable) layer
 * - Reads fall back to lower (read-only) layer
 * - Modifications trigger copy-on-write from lower to upper
 * - Deletions create whiteouts to hide lower layer files
 * - Opaque directories completely mask lower contents
 *
 * Similar to Docker's overlay filesystem and Linux OverlayFS
 *
 * Example:
 * ```javascript
 * const upper = new MemoryProvider();
 * const lower = new LocalProvider();
 * const overlay = new OverlayProvider(upper, lower);
 * ```
 */
class OverlayProvider extends VirtualProvider {
  constructor(upper, lower, options = {}) {
    super();

    this.upper = upper;
    this.lower = lower;

    // Whiteouts: paths deleted from lower layer
    this._whiteouts = new Set();

    // Opaque directories: directories that completely hide lower contents
    this._opaqueDirs = new Set();

    // Optional metadata persistence
    this.metadataPath = options.metadataPath;

    if (this.metadataPath) {
      this._loadMetadata();
    }
  }

  // === CAPABILITY DELEGATION ===

  get supportsSymlinks() {
    return this.upper.supportsSymlinks || this.lower.supportsSymlinks;
  }

  get supportsHardLinks() {
    return this.upper.supportsHardLinks;
  }

  get supportsPermissions() {
    return this.upper.supportsPermissions || this.lower.supportsPermissions;
  }

  get supportsChown() {
    return this.upper.supportsChown;
  }

  get supportsLocking() {
    return this.upper.supportsLocking;
  }

  get supportsFsync() {
    return this.upper.supportsFsync;
  }

  get supportsUtime() {
    return this.upper.supportsUtime || this.lower.supportsUtime;
  }

  // === PRIMITIVES ===

  async open(path, flags, mode) {
    const key = this._normalizePath(path);
    const isRead = (flags & 3) === 0; // O_RDONLY
    const isWrite = (flags & 3) !== 0;

    if (isRead) {
      // Read-only: check upper first, then lower
      if (await this.upper.exists(key)) {
        return await this.upper.open(key, flags, mode);
      }

      if (this._isWhitedOut(key)) {
        throw ENOENT('open', path);
      }

      if (await this.lower.exists(key)) {
        return await this.lower.open(key, flags, mode);
      }

      throw ENOENT('open', path);
    } else {
      // Write: ensure in upper layer
      await this._prepareForWrite(key);

      // Copy-on-write if exists in lower but not upper
      if (!await this.upper.exists(key) && await this._existsInLower(key)) {
        await this._copyToUpper(key);
      }

      return await this.upper.open(key, flags, mode);
    }
  }

  openSync(path, flags, mode) {
    const key = this._normalizePath(path);
    const isRead = (flags & 3) === 0;
    const isWrite = (flags & 3) !== 0;

    if (isRead) {
      if (this.upper.existsSync(key)) {
        return this.upper.openSync(key, flags, mode);
      }

      if (this._isWhitedOut(key)) {
        throw ENOENT('open', path);
      }

      if (this.lower.existsSync(key)) {
        return this.lower.openSync(key, flags, mode);
      }

      throw ENOENT('open', path);
    } else {
      this._prepareForWriteSync(key);

      if (!this.upper.existsSync(key) && this._existsInLowerSync(key)) {
        this._copyToUpperSync(key);
      }

      return this.upper.openSync(key, flags, mode);
    }
  }

  async stat(path, options = {}) {
    const key = this._normalizePath(path);

    // Check upper first
    try {
      return await this.upper.stat(key, options);
    } catch {}

    // Check if whited out
    if (this._isWhitedOut(key)) {
      throw ENOENT('stat', path);
    }

    // Check lower
    try {
      return await this.lower.stat(key, options);
    } catch {}

    throw ENOENT('stat', path);
  }

  statSync(path, options = {}) {
    const key = this._normalizePath(path);

    try {
      return this.upper.statSync(key, options);
    } catch {}

    if (this._isWhitedOut(key)) {
      throw ENOENT('stat', path);
    }

    try {
      return this.lower.statSync(key, options);
    } catch {}

    throw ENOENT('stat', path);
  }

  async unlink(path) {
    const key = this._normalizePath(path);

    // Delete from upper if exists
    if (await this.upper.exists(key)) {
      await this.upper.unlink(key);
    }

    // Add whiteout if exists in lower
    if (await this._existsInLower(key)) {
      this._whiteouts.add(key);
      await this._saveMetadata();
    }
  }

  unlinkSync(path) {
    const key = this._normalizePath(path);

    if (this.upper.existsSync(key)) {
      this.upper.unlinkSync(key);
    }

    if (this._existsInLowerSync(key)) {
      this._whiteouts.add(key);
      this._saveMetadataSync();
    }
  }

  async rename(oldPath, newPath) {
    const oldKey = this._normalizePath(oldPath);
    const newKey = this._normalizePath(newPath);

    // Ensure source exists (upper or lower)
    const inUpper = await this.upper.exists(oldKey);
    const inLower = !this._isWhitedOut(oldKey) && await this._existsInLower(oldKey);

    if (!inUpper && !inLower) {
      throw ENOENT('rename', oldPath);
    }

    // Copy to upper if needed
    if (!inUpper && inLower) {
      await this._copyToUpper(oldKey);
    }

    // Prepare destination
    await this._prepareForWrite(newKey);

    // Rename in upper layer
    await this.upper.rename(oldKey, newKey);

    // Add whiteout for old path if it existed in lower
    if (inLower) {
      this._whiteouts.add(oldKey);
    }

    // Remove whiteout for new path
    this._whiteouts.delete(newKey);

    await this._saveMetadata();
  }

  renameSync(oldPath, newPath) {
    const oldKey = this._normalizePath(oldPath);
    const newKey = this._normalizePath(newPath);

    const inUpper = this.upper.existsSync(oldKey);
    const inLower = !this._isWhitedOut(oldKey) && this._existsInLowerSync(oldKey);

    if (!inUpper && !inLower) {
      throw ENOENT('rename', oldPath);
    }

    if (!inUpper && inLower) {
      this._copyToUpperSync(oldKey);
    }

    this._prepareForWriteSync(newKey);
    this.upper.renameSync(oldKey, newKey);

    if (inLower) {
      this._whiteouts.add(oldKey);
    }

    this._whiteouts.delete(newKey);
    this._saveMetadataSync();
  }

  async chmod(path, mode) {
    const key = this._normalizePath(path);

    // Copy to upper if only in lower
    if (!await this.upper.exists(key) && await this._existsInLower(key)) {
      await this._copyToUpper(key);
    }

    return await this.upper.chmod(key, mode);
  }

  chmodSync(path, mode) {
    const key = this._normalizePath(path);

    if (!this.upper.existsSync(key) && this._existsInLowerSync(key)) {
      this._copyToUpperSync(key);
    }

    return this.upper.chmodSync(key, mode);
  }

  async chown(path, uid, gid) {
    const key = this._normalizePath(path);

    if (!await this.upper.exists(key) && await this._existsInLower(key)) {
      await this._copyToUpper(key);
    }

    return await this.upper.chown(key, uid, gid);
  }

  chownSync(path, uid, gid) {
    const key = this._normalizePath(path);

    if (!this.upper.existsSync(key) && this._existsInLowerSync(key)) {
      this._copyToUpperSync(key);
    }

    return this.upper.chownSync(key, uid, gid);
  }

  async utimes(path, atime, mtime) {
    const key = this._normalizePath(path);

    if (!await this.upper.exists(key) && await this._existsInLower(key)) {
      await this._copyToUpper(key);
    }

    return await this.upper.utimes(key, atime, mtime);
  }

  utimesSync(path, atime, mtime) {
    const key = this._normalizePath(path);

    if (!this.upper.existsSync(key) && this._existsInLowerSync(key)) {
      this._copyToUpperSync(key);
    }

    return this.upper.utimesSync(key, atime, mtime);
  }

  async link(existingPath, newPath) {
    const existingKey = this._normalizePath(existingPath);
    const newKey = this._normalizePath(newPath);

    // Ensure existing file is in upper
    if (!await this.upper.exists(existingKey) && await this._existsInLower(existingKey)) {
      await this._copyToUpper(existingKey);
    }

    await this._prepareForWrite(newKey);
    return await this.upper.link(existingKey, newKey);
  }

  linkSync(existingPath, newPath) {
    const existingKey = this._normalizePath(existingPath);
    const newKey = this._normalizePath(newPath);

    if (!this.upper.existsSync(existingKey) && this._existsInLowerSync(existingKey)) {
      this._copyToUpperSync(existingKey);
    }

    this._prepareForWriteSync(newKey);
    return this.upper.linkSync(existingKey, newKey);
  }

  async symlink(target, path, type) {
    const key = this._normalizePath(path);
    await this._prepareForWrite(key);
    return await this.upper.symlink(target, key, type);
  }

  symlinkSync(target, path, type) {
    const key = this._normalizePath(path);
    this._prepareForWriteSync(key);
    return this.upper.symlinkSync(target, key, type);
  }

  async readlink(path) {
    const key = this._normalizePath(path);

    if (await this.upper.exists(key)) {
      return await this.upper.readlink(key);
    }

    if (this._isWhitedOut(key)) {
      throw ENOENT('readlink', path);
    }

    return await this.lower.readlink(key);
  }

  readlinkSync(path) {
    const key = this._normalizePath(path);

    if (this.upper.existsSync(key)) {
      return this.upper.readlinkSync(key);
    }

    if (this._isWhitedOut(key)) {
      throw ENOENT('readlink', path);
    }

    return this.lower.readlinkSync(key);
  }

  async mkdir(path, options = {}) {
    const key = this._normalizePath(path);
    await this._prepareForWrite(key);
    return await this.upper.mkdir(key, options);
  }

  mkdirSync(path, options = {}) {
    const key = this._normalizePath(path);
    this._prepareForWriteSync(key);
    return this.upper.mkdirSync(key, options);
  }

  async rmdir(path) {
    const key = this._normalizePath(path);

    if (await this.upper.exists(key)) {
      await this.upper.rmdir(key);
    }

    if (await this._existsInLower(key)) {
      this._whiteouts.add(key);
      await this._saveMetadata();
    }
  }

  rmdirSync(path) {
    const key = this._normalizePath(path);

    if (this.upper.existsSync(key)) {
      this.upper.rmdirSync(key);
    }

    if (this._existsInLowerSync(key)) {
      this._whiteouts.add(key);
      this._saveMetadataSync();
    }
  }

  async readdir(path, options = {}) {
    const key = this._normalizePath(path);
    const entries = new Set();

    // Get entries from upper
    try {
      const upperEntries = await this.upper.readdir(key, options);
      for (const entry of upperEntries) {
        const name = typeof entry === 'string' ? entry : entry.name;
        entries.add(name);
      }
    } catch {}

    // Get entries from lower (if not opaque)
    if (!this._isOpaque(key)) {
      try {
        const lowerEntries = await this.lower.readdir(key, options);
        for (const entry of lowerEntries) {
          const name = typeof entry === 'string' ? entry : entry.name;
          const childPath = pathModule.join(key, name);

          // Skip if whited out
          if (!this._isWhitedOut(childPath)) {
            entries.add(name);
          }
        }
      } catch {}
    }

    return Array.from(entries);
  }

  readdirSync(path, options = {}) {
    const key = this._normalizePath(path);
    const entries = new Set();

    try {
      const upperEntries = this.upper.readdirSync(key, options);
      for (const entry of upperEntries) {
        const name = typeof entry === 'string' ? entry : entry.name;
        entries.add(name);
      }
    } catch {}

    if (!this._isOpaque(key)) {
      try {
        const lowerEntries = this.lower.readdirSync(key, options);
        for (const entry of lowerEntries) {
          const name = typeof entry === 'string' ? entry : entry.name;
          const childPath = pathModule.join(key, name);

          if (!this._isWhitedOut(childPath)) {
            entries.add(name);
          }
        }
      } catch {}
    }

    return Array.from(entries);
  }

  tmpdir() {
    return this.upper.tmpdir();
  }

  // === HELPER METHODS ===

  _normalizePath(path) {
    return pathModule.normalize(path).replace(/\\/g, '/');
  }

  _isWhitedOut(path) {
    return this._whiteouts.has(path);
  }

  _isOpaque(path) {
    return this._opaqueDirs.has(path);
  }

  async _existsInLower(path) {
    try {
      await this.lower.stat(path);
      return true;
    } catch {
      return false;
    }
  }

  _existsInLowerSync(path) {
    try {
      this.lower.statSync(path);
      return true;
    } catch {
      return false;
    }
  }

  async _prepareForWrite(path) {
    // Ensure parent directories exist
    const parent = pathModule.dirname(path);
    if (parent !== '/' && parent !== '.') {
      try {
        await this.upper.stat(parent);
      } catch {
        await this.upper.mkdir(parent, { recursive: true });
      }
    }

    // Remove whiteout if exists
    if (this._whiteouts.delete(path)) {
      await this._saveMetadata();
    }
  }

  _prepareForWriteSync(path) {
    const parent = pathModule.dirname(path);
    if (parent !== '/' && parent !== '.') {
      try {
        this.upper.statSync(parent);
      } catch {
        this.upper.mkdirSync(parent, { recursive: true });
      }
    }

    if (this._whiteouts.delete(path)) {
      this._saveMetadataSync();
    }
  }

  async _copyToUpper(path) {
    const content = await this.lower.readFile(path);
    const stats = await this.lower.stat(path);

    await this._prepareForWrite(path);
    await this.upper.writeFile(path, content);

    if (this.upper.supportsPermissions) {
      await this.upper.chmod(path, stats.mode & 0o777);
    }
  }

  _copyToUpperSync(path) {
    const content = this.lower.readFileSync(path);
    const stats = this.lower.statSync(path);

    this._prepareForWriteSync(path);
    this.upper.writeFileSync(path, content);

    if (this.upper.supportsPermissions) {
      this.upper.chmodSync(path, stats.mode & 0o777);
    }
  }

  async _saveMetadata() {
    if (!this.metadataPath) return;

    const metadata = {
      whiteouts: Array.from(this._whiteouts),
      opaqueDirs: Array.from(this._opaqueDirs),
    };

    await this.upper.writeFile(this.metadataPath, JSON.stringify(metadata));
  }

  _saveMetadataSync() {
    if (!this.metadataPath) return;

    const metadata = {
      whiteouts: Array.from(this._whiteouts),
      opaqueDirs: Array.from(this._opaqueDirs),
    };

    this.upper.writeFileSync(this.metadataPath, JSON.stringify(metadata));
  }

  async _loadMetadata() {
    if (!this.metadataPath) return;

    try {
      const content = await this.upper.readFile(this.metadataPath, 'utf8');
      const metadata = JSON.parse(content);

      this._whiteouts = new Set(metadata.whiteouts || []);
      this._opaqueDirs = new Set(metadata.opaqueDirs || []);
    } catch {
      // Metadata file doesn't exist or is invalid
    }
  }
}

module.exports = { OverlayProvider };
