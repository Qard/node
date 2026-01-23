'use strict';

const {
  ObjectDefineProperty,
  Promise,
  PromiseReject,
} = primordials;

const pathModule = require('path');
const { Buffer } = require('buffer');
const { Readable, Writable } = require('stream');

const {
  ReadOnlyError,
  ENOENT,
  EEXIST,
  EISDIR,
  ENOTDIR,
  ENOTEMPTY,
  ELOOP,
} = require('internal/fs/vfs/errors');

const { createVirtualStats } = require('internal/fs/vfs/stats');

const {
  S_IFMT,
  S_IFREG,
  S_IFDIR,
  O_RDONLY,
  O_WRONLY,
  O_RDWR,
  O_CREAT,
  O_EXCL,
  O_TRUNC,
  O_APPEND,
} = internalBinding('constants').fs;

// Abstract base class for Virtual providers
// Providers implement ~15 essential primitives and get ~35+ methods with default implementations
class VirtualProvider {
  // === ESSENTIAL PRIMITIVES (must implement in subclass) ===

  /**
   * Open a file and return a file handle
   * @param {string} path - Path to file
   * @param {number} flags - File open flags (O_RDONLY, O_WRONLY, O_RDWR, etc.)
   * @param {number} mode - File mode (permissions)
   * @returns {Promise<Object>} File handle with read/write/close methods
   */
  async open(path, flags, mode) {
    throw new Error('Provider must implement open()');
  }

  /**
   * Open a file synchronously
   * @param {string} path - Path to file
   * @param {number} flags - File open flags
   * @param {number} mode - File mode (permissions)
   * @returns {Object} File handle
   */
  openSync(path, flags, mode) {
    throw new Error('Provider must implement openSync()');
  }

  /**
   * Get file metadata
   * @param {string} path - Path to file or directory
   * @param {Object} options - Options { followSymlinks: true }
   * @returns {Promise<VirtualStats>} File stats
   */
  async stat(path, options = {}) {
    throw new Error('Provider must implement stat()');
  }

  /**
   * Get file metadata synchronously
   * @param {string} path - Path to file or directory
   * @param {Object} options - Options
   * @returns {VirtualStats} File stats
   */
  statSync(path, options = {}) {
    throw new Error('Provider must implement statSync()');
  }

  /**
   * Delete a file
   * @param {string} path - Path to file
   * @returns {Promise<void>}
   */
  async unlink(path) {
    throw new Error('Provider must implement unlink()');
  }

  /**
   * Delete a file synchronously
   * @param {string} path - Path to file
   * @returns {void}
   */
  unlinkSync(path) {
    throw new Error('Provider must implement unlinkSync()');
  }

  /**
   * Rename or move a file/directory
   * @param {string} oldPath - Current path
   * @param {string} newPath - New path
   * @returns {Promise<void>}
   */
  async rename(oldPath, newPath) {
    throw new Error('Provider must implement rename()');
  }

  /**
   * Rename or move a file/directory synchronously
   * @param {string} oldPath - Current path
   * @param {string} newPath - New path
   * @returns {void}
   */
  renameSync(oldPath, newPath) {
    throw new Error('Provider must implement renameSync()');
  }

  /**
   * Change file permissions
   * @param {string} path - Path to file
   * @param {number} mode - New file mode
   * @returns {Promise<void>}
   */
  async chmod(path, mode) {
    throw new Error('Provider must implement chmod()');
  }

  /**
   * Change file permissions synchronously
   * @param {string} path - Path to file
   * @param {number} mode - New file mode
   * @returns {void}
   */
  chmodSync(path, mode) {
    throw new Error('Provider must implement chmodSync()');
  }

  /**
   * Change file ownership
   * @param {string} path - Path to file
   * @param {number} uid - User ID
   * @param {number} gid - Group ID
   * @returns {Promise<void>}
   */
  async chown(path, uid, gid) {
    throw new Error('Provider must implement chown()');
  }

  /**
   * Change file ownership synchronously
   * @param {string} path - Path to file
   * @param {number} uid - User ID
   * @param {number} gid - Group ID
   * @returns {void}
   */
  chownSync(path, uid, gid) {
    throw new Error('Provider must implement chownSync()');
  }

  /**
   * Update file access and modification times
   * @param {string} path - Path to file
   * @param {number|Date} atime - Access time
   * @param {number|Date} mtime - Modification time
   * @returns {Promise<void>}
   */
  async utimes(path, atime, mtime) {
    throw new Error('Provider must implement utimes()');
  }

  /**
   * Update file times synchronously
   * @param {string} path - Path to file
   * @param {number|Date} atime - Access time
   * @param {number|Date} mtime - Modification time
   * @returns {void}
   */
  utimesSync(path, atime, mtime) {
    throw new Error('Provider must implement utimesSync()');
  }

  /**
   * Create a hard link
   * @param {string} existingPath - Target file
   * @param {string} newPath - Link path
   * @returns {Promise<void>}
   */
  async link(existingPath, newPath) {
    throw new Error('Provider must implement link()');
  }

  /**
   * Create a hard link synchronously
   * @param {string} existingPath - Target file
   * @param {string} newPath - Link path
   * @returns {void}
   */
  linkSync(existingPath, newPath) {
    throw new Error('Provider must implement linkSync()');
  }

  /**
   * Create a symbolic link
   * @param {string} target - Link target
   * @param {string} path - Link path
   * @param {string} type - 'file', 'dir', or 'junction'
   * @returns {Promise<void>}
   */
  async symlink(target, path, type) {
    throw new Error('Provider must implement symlink()');
  }

  /**
   * Create a symbolic link synchronously
   * @param {string} target - Link target
   * @param {string} path - Link path
   * @param {string} type - Link type
   * @returns {void}
   */
  symlinkSync(target, path, type) {
    throw new Error('Provider must implement symlinkSync()');
  }

  /**
   * Read the target of a symbolic link
   * @param {string} path - Link path
   * @returns {Promise<string>} Link target
   */
  async readlink(path) {
    throw new Error('Provider must implement readlink()');
  }

  /**
   * Read the target of a symbolic link synchronously
   * @param {string} path - Link path
   * @returns {string} Link target
   */
  readlinkSync(path) {
    throw new Error('Provider must implement readlinkSync()');
  }

  /**
   * Create a directory
   * @param {string} path - Directory path
   * @param {Object} options - Options { mode, recursive }
   * @returns {Promise<void|string>}
   */
  async mkdir(path, options = {}) {
    throw new Error('Provider must implement mkdir()');
  }

  /**
   * Create a directory synchronously
   * @param {string} path - Directory path
   * @param {Object} options - Options
   * @returns {void|string}
   */
  mkdirSync(path, options = {}) {
    throw new Error('Provider must implement mkdirSync()');
  }

  /**
   * Remove a directory
   * @param {string} path - Directory path
   * @returns {Promise<void>}
   */
  async rmdir(path) {
    throw new Error('Provider must implement rmdir()');
  }

  /**
   * Remove a directory synchronously
   * @param {string} path - Directory path
   * @returns {void}
   */
  rmdirSync(path) {
    throw new Error('Provider must implement rmdirSync()');
  }

  /**
   * Read directory entries
   * @param {string} path - Directory path
   * @param {Object} options - Options
   * @returns {Promise<Array<string|VirtualDirent>>} Directory entries
   */
  async readdir(path, options = {}) {
    throw new Error('Provider must implement readdir()');
  }

  /**
   * Read directory entries synchronously
   * @param {string} path - Directory path
   * @param {Object} options - Options
   * @returns {Array<string|VirtualDirent>} Directory entries
   */
  readdirSync(path, options = {}) {
    throw new Error('Provider must implement readdirSync()');
  }

  /**
   * Get temporary directory path
   * @returns {string} Temp directory path
   */
  tmpdir() {
    throw new Error('Provider must implement tmpdir()');
  }

  // === CAPABILITY DETECTION ===

  /** @returns {boolean} Whether provider is read-only */
  get readonly() {
    return false;
  }

  /** @returns {boolean} Whether provider supports symbolic links */
  get supportsSymlinks() {
    return false;
  }

  /** @returns {boolean} Whether provider supports hard links */
  get supportsHardLinks() {
    return false;
  }

  /** @returns {boolean} Whether provider supports file permissions */
  get supportsPermissions() {
    return true;
  }

  /** @returns {boolean} Whether provider supports chown */
  get supportsChown() {
    return false;
  }

  /** @returns {boolean} Whether provider supports file locking */
  get supportsLocking() {
    return false;
  }

  /** @returns {boolean} Whether provider supports fsync */
  get supportsFsync() {
    return false;
  }

  /** @returns {boolean} Whether provider supports watch */
  get supportsWatch() {
    return false;
  }

  /** @returns {boolean} Whether provider supports temp directories */
  get supportsTempDirectory() {
    return true;
  }

  /** @returns {boolean} Whether provider supports utime */
  get supportsUtime() {
    return true;
  }

  /** @returns {boolean} Whether delete raises on missing files */
  get deleteRaisesOnMissing() {
    return true;
  }

  /** @returns {boolean} Whether mkdir raises on existing directories */
  get mkdirRaisesOnExists() {
    return true;
  }

  // === DEFAULT IMPLEMENTATIONS ===

  /**
   * Read entire file content
   * @param {string} path - File path
   * @param {Object} options - Options { encoding, flag }
   * @returns {Promise<string|Buffer>} File content
   */
  async readFile(path, options = {}) {
    const encoding = options.encoding;
    const flag = options.flag || 'r';
    const flags = typeof flag === 'string' ? stringToFlags(flag) : flag;

    const handle = await this.open(path, flags, 0o666);
    try {
      const chunks = [];
      let totalLength = 0;

      while (true) {
        const chunk = Buffer.allocUnsafe(64 * 1024);
        const bytesRead = await handle.read(chunk, 0, chunk.length, null);

        if (bytesRead === 0) break;

        chunks.push(chunk.subarray(0, bytesRead));
        totalLength += bytesRead;
      }

      const result = Buffer.concat(chunks, totalLength);
      return encoding ? result.toString(encoding) : result;
    } finally {
      await handle.close();
    }
  }

  /**
   * Read file synchronously
   * @param {string} path - File path
   * @param {Object} options - Options
   * @returns {string|Buffer} File content
   */
  readFileSync(path, options = {}) {
    const encoding = options.encoding;
    const flag = options.flag || 'r';
    const flags = typeof flag === 'string' ? stringToFlags(flag) : flag;

    const handle = this.openSync(path, flags, 0o666);
    try {
      const chunks = [];
      let totalLength = 0;

      while (true) {
        const chunk = Buffer.allocUnsafe(64 * 1024);
        const bytesRead = handle.readSync(chunk, 0, chunk.length, null);

        if (bytesRead === 0) break;

        chunks.push(chunk.subarray(0, bytesRead));
        totalLength += bytesRead;
      }

      const result = Buffer.concat(chunks, totalLength);
      return encoding ? result.toString(encoding) : result;
    } finally {
      handle.closeSync();
    }
  }

  /**
   * Write content to file
   * @param {string} path - File path
   * @param {string|Buffer} data - Data to write
   * @param {Object} options - Options { encoding, mode, flag }
   * @returns {Promise<void>}
   */
  async writeFile(path, data, options = {}) {
    const encoding = options.encoding || 'utf8';
    const mode = options.mode || 0o666;
    const flag = options.flag || 'w';
    const flags = typeof flag === 'string' ? stringToFlags(flag) : flag;

    const buffer = typeof data === 'string' ? Buffer.from(data, encoding) : data;

    const handle = await this.open(path, flags, mode);
    try {
      let offset = 0;
      while (offset < buffer.length) {
        const bytesWritten = await handle.write(buffer, offset, buffer.length - offset, null);
        offset += bytesWritten;
      }
    } finally {
      await handle.close();
    }
  }

  /**
   * Write file synchronously
   * @param {string} path - File path
   * @param {string|Buffer} data - Data to write
   * @param {Object} options - Options
   * @returns {void}
   */
  writeFileSync(path, data, options = {}) {
    const encoding = options.encoding || 'utf8';
    const mode = options.mode || 0o666;
    const flag = options.flag || 'w';
    const flags = typeof flag === 'string' ? stringToFlags(flag) : flag;

    const buffer = typeof data === 'string' ? Buffer.from(data, encoding) : data;

    const handle = this.openSync(path, flags, mode);
    try {
      let offset = 0;
      while (offset < buffer.length) {
        const bytesWritten = handle.writeSync(buffer, offset, buffer.length - offset, null);
        offset += bytesWritten;
      }
    } finally {
      handle.closeSync();
    }
  }

  /**
   * Append data to file
   * @param {string} path - File path
   * @param {string|Buffer} data - Data to append
   * @param {Object} options - Options
   * @returns {Promise<void>}
   */
  async appendFile(path, data, options = {}) {
    return this.writeFile(path, data, {
      ...options,
      flag: 'a',
    });
  }

  /**
   * Append data synchronously
   * @param {string} path - File path
   * @param {string|Buffer} data - Data to append
   * @param {Object} options - Options
   * @returns {void}
   */
  appendFileSync(path, data, options = {}) {
    return this.writeFileSync(path, data, {
      ...options,
      flag: 'a',
    });
  }

  /**
   * Check if path exists
   * @param {string} path - Path to check
   * @returns {Promise<boolean>}
   */
  async exists(path) {
    try {
      await this.stat(path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if path exists synchronously
   * @param {string} path - Path to check
   * @returns {boolean}
   */
  existsSync(path) {
    try {
      this.statSync(path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Copy a file
   * @param {string} src - Source path
   * @param {string} dest - Destination path
   * @param {number} flags - Copy flags
   * @returns {Promise<void>}
   */
  async copyFile(src, dest, flags = 0) {
    const COPYFILE_EXCL = 1;

    if (flags & COPYFILE_EXCL) {
      if (await this.exists(dest)) {
        throw EEXIST('copyFile', dest);
      }
    }

    const srcHandle = await this.open(src, O_RDONLY, 0);
    try {
      const stats = await this.stat(src);
      const destHandle = await this.open(dest, O_WRONLY | O_CREAT | O_TRUNC, stats.mode);
      try {
        const buffer = Buffer.allocUnsafe(64 * 1024);
        while (true) {
          const bytesRead = await srcHandle.read(buffer, 0, buffer.length, null);
          if (bytesRead === 0) break;

          let offset = 0;
          while (offset < bytesRead) {
            const bytesWritten = await destHandle.write(buffer, offset, bytesRead - offset, null);
            offset += bytesWritten;
          }
        }
      } finally {
        await destHandle.close();
      }
    } finally {
      await srcHandle.close();
    }

    if (this.supportsPermissions) {
      const stats = await this.stat(src);
      await this.chmod(dest, stats.mode);
    }
  }

  /**
   * Copy file synchronously
   * @param {string} src - Source path
   * @param {string} dest - Destination path
   * @param {number} flags - Copy flags
   * @returns {void}
   */
  copyFileSync(src, dest, flags = 0) {
    const COPYFILE_EXCL = 1;

    if (flags & COPYFILE_EXCL) {
      if (this.existsSync(dest)) {
        throw EEXIST('copyFile', dest);
      }
    }

    const srcHandle = this.openSync(src, O_RDONLY, 0);
    try {
      const stats = this.statSync(src);
      const destHandle = this.openSync(dest, O_WRONLY | O_CREAT | O_TRUNC, stats.mode);
      try {
        const buffer = Buffer.allocUnsafe(64 * 1024);
        while (true) {
          const bytesRead = srcHandle.readSync(buffer, 0, buffer.length, null);
          if (bytesRead === 0) break;

          let offset = 0;
          while (offset < bytesRead) {
            const bytesWritten = destHandle.writeSync(buffer, offset, bytesRead - offset, null);
            offset += bytesWritten;
          }
        }
      } finally {
        destHandle.closeSync();
      }
    } finally {
      srcHandle.closeSync();
    }

    if (this.supportsPermissions) {
      const stats = this.statSync(src);
      this.chmodSync(dest, stats.mode);
    }
  }

  /**
   * Resolve real path following symlinks
   * @param {string} path - Path to resolve
   * @param {Object} options - Options
   * @returns {Promise<string>} Real path
   */
  async realpath(path, options = {}) {
    let current = pathModule.resolve(path);
    const visited = new Set();
    const maxDepth = 40;

    for (let i = 0; i < maxDepth; i++) {
      let stats;
      try {
        stats = await this.stat(current, { followSymlinks: false });
      } catch (err) {
        if (err.code === 'ENOENT') {
          throw ENOENT('lstat', current);
        }
        throw err;
      }

      if (!stats.isSymbolicLink()) {
        return current;
      }

      if (visited.has(current)) {
        throw ELOOP('realpath', path);
      }

      visited.add(current);

      const target = await this.readlink(current);
      current = pathModule.isAbsolute(target)
        ? target
        : pathModule.resolve(pathModule.dirname(current), target);
    }

    throw ELOOP('realpath', path);
  }

  /**
   * Resolve real path synchronously
   * @param {string} path - Path to resolve
   * @param {Object} options - Options
   * @returns {string} Real path
   */
  realpathSync(path, options = {}) {
    let current = pathModule.resolve(path);
    const visited = new Set();
    const maxDepth = 40;

    for (let i = 0; i < maxDepth; i++) {
      let stats;
      try {
        stats = this.statSync(current, { followSymlinks: false });
      } catch (err) {
        if (err.code === 'ENOENT') {
          throw ENOENT('lstat', current);
        }
        throw err;
      }

      if (!stats.isSymbolicLink()) {
        return current;
      }

      if (visited.has(current)) {
        throw ELOOP('realpath', path);
      }

      visited.add(current);

      const target = this.readlinkSync(current);
      current = pathModule.isAbsolute(target)
        ? target
        : pathModule.resolve(pathModule.dirname(current), target);
    }

    throw ELOOP('realpath', path);
  }

  /**
   * Get stats or null if not exists
   * @param {string} path - Path to check
   * @param {Object} options - Options
   * @returns {Promise<VirtualStats|null>}
   */
  async statOrNull(path, options = {}) {
    try {
      return await this.stat(path, options);
    } catch {
      return null;
    }
  }

  /**
   * Get stats or null synchronously
   * @param {string} path - Path to check
   * @param {Object} options - Options
   * @returns {VirtualStats|null}
   */
  statOrNullSync(path, options = {}) {
    try {
      return this.statSync(path, options);
    } catch {
      return null;
    }
  }

  /**
   * Watch for changes on a file or directory
   * Default implementation throws - override in providers that support watching
   * @param {string} filename - Path to watch
   * @param {Object} options - Watch options
   * @param {Function} listener - Change listener
   * @returns {FSWatcher}
   */
  watch(filename, options, listener) {
    throw new Error(`${this.constructor.name} does not support watch()`);
  }

  /**
   * Watch file for stat changes
   * Default implementation throws - override in providers that support watching
   * @param {string} filename - Path to watch
   * @param {Object} options - Watch options
   * @param {Function} listener - Change listener
   * @returns {StatWatcher}
   */
  watchFile(filename, options, listener) {
    throw new Error(`${this.constructor.name} does not support watchFile()`);
  }

  /**
   * Stop watching a file
   * Default implementation is a no-op
   * @param {string} filename - Path to stop watching
   * @param {Function} listener - Listener to remove
   */
  unwatchFile(filename, listener) {
    // No-op by default
  }
}

// Helper: Convert string flags to numeric flags
function stringToFlags(flags) {
  switch (flags) {
    case 'r': return O_RDONLY;
    case 'r+': return O_RDWR;
    case 'rs': case 'sr': return O_RDONLY; // Sync flags ignored
    case 'rs+': case 'sr+': return O_RDWR;
    case 'w': return O_WRONLY | O_CREAT | O_TRUNC;
    case 'wx': case 'xw': return O_WRONLY | O_CREAT | O_TRUNC | O_EXCL;
    case 'w+': return O_RDWR | O_CREAT | O_TRUNC;
    case 'wx+': case 'xw+': return O_RDWR | O_CREAT | O_TRUNC | O_EXCL;
    case 'a': return O_WRONLY | O_APPEND | O_CREAT;
    case 'ax': case 'xa': return O_WRONLY | O_APPEND | O_CREAT | O_EXCL;
    case 'as': case 'sa': return O_WRONLY | O_APPEND | O_CREAT;
    case 'a+': return O_RDWR | O_APPEND | O_CREAT;
    case 'ax+': case 'xa+': return O_RDWR | O_APPEND | O_CREAT | O_EXCL;
    case 'as+': case 'sa+': return O_RDWR | O_APPEND | O_CREAT;
    default:
      throw new Error(`Unknown file open flag: ${flags}`);
  }
}

module.exports = {
  VirtualProvider,
  stringToFlags,
};
