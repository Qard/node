'use strict';

const {
  ObjectCreate,
  ObjectDefineProperty,
  Promise,
  ReflectApply,
} = primordials;

const pathModule = require('path');
const { VirtualFileHandle, VirtualFileHandleSync } = require('internal/fs/vfs/file_handle');
const { stringToFlags } = require('internal/fs/vfs/provider');

const kProvider = Symbol('kProvider');
const kCwd = Symbol('kCwd');
const kPromises = Symbol('kPromises');

/**
 * VirtualFileSystem - Main coordinator for Virtual File System
 * Provides callback, sync, and promise-based APIs similar to Node.js fs module
 */
class VirtualFileSystem {
  constructor(provider, cwd = '/') {
    this[kProvider] = provider;
    this[kCwd] = cwd;
    this[kPromises] = null;  // Lazy-loaded
  }

  get provider() {
    return this[kProvider];
  }

  get cwd() {
    return this[kCwd];
  }

  set cwd(value) {
    this[kCwd] = value;
  }

  /**
   * Resolve path relative to virtual CWD
   * @param {string} path - Path to resolve
   * @returns {string} Absolute path
   */
  resolvePath(path) {
    if (pathModule.isAbsolute(path)) {
      return pathModule.normalize(path);
    }
    return pathModule.normalize(pathModule.join(this[kCwd], path));
  }

  /**
   * Get promises API
   * @returns {VirtualPromises} Promises API
   */
  get promises() {
    if (!this[kPromises]) {
      this[kPromises] = new VirtualPromises(this);
    }
    return this[kPromises];
  }

  // === CALLBACK API ===

  /**
   * Read file (callback)
   * @param {string} path - File path
   * @param {Object|Function} options - Options or callback
   * @param {Function} callback - Callback function
   */
  readFile(path, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }

    path = this.resolvePath(path);

    this[kProvider].readFile(path, options)
      .then((data) => callback(null, data))
      .catch((err) => callback(err));
  }

  /**
   * Write file (callback)
   * @param {string} path - File path
   * @param {string|Buffer} data - Data to write
   * @param {Object|Function} options - Options or callback
   * @param {Function} callback - Callback function
   */
  writeFile(path, data, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }

    path = this.resolvePath(path);

    this[kProvider].writeFile(path, data, options)
      .then(() => callback(null))
      .catch((err) => callback(err));
  }

  /**
   * Append file (callback)
   * @param {string} path - File path
   * @param {string|Buffer} data - Data to append
   * @param {Object|Function} options - Options or callback
   * @param {Function} callback - Callback function
   */
  appendFile(path, data, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }

    path = this.resolvePath(path);

    this[kProvider].appendFile(path, data, options)
      .then(() => callback(null))
      .catch((err) => callback(err));
  }

  /**
   * Get file stats (callback)
   * @param {string} path - File path
   * @param {Object|Function} options - Options or callback
   * @param {Function} callback - Callback function
   */
  stat(path, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }

    path = this.resolvePath(path);

    this[kProvider].stat(path, options)
      .then((stats) => callback(null, stats))
      .catch((err) => callback(err));
  }

  /**
   * Get file stats without following symlinks (callback)
   * @param {string} path - File path
   * @param {Object|Function} options - Options or callback
   * @param {Function} callback - Callback function
   */
  lstat(path, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }

    path = this.resolvePath(path);

    this[kProvider].stat(path, { ...options, followSymlinks: false })
      .then((stats) => callback(null, stats))
      .catch((err) => callback(err));
  }

  /**
   * Check file access (callback)
   * @param {string} path - File path
   * @param {number|Function} mode - Access mode or callback
   * @param {Function} callback - Callback function
   */
  access(path, mode, callback) {
    if (typeof mode === 'function') {
      callback = mode;
      mode = 0;  // F_OK
    }

    path = this.resolvePath(path);

    this[kProvider].exists(path)
      .then((exists) => {
        if (!exists) {
          const err = new Error('ENOENT: no such file or directory');
          err.code = 'ENOENT';
          throw err;
        }
      })
      .then(() => callback(null))
      .catch((err) => callback(err));
  }

  /**
   * Make directory (callback)
   * @param {string} path - Directory path
   * @param {Object|Function} options - Options or callback
   * @param {Function} callback - Callback function
   */
  mkdir(path, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }

    path = this.resolvePath(path);

    this[kProvider].mkdir(path, options)
      .then((result) => callback(null, result))
      .catch((err) => callback(err));
  }

  /**
   * Remove directory (callback)
   * @param {string} path - Directory path
   * @param {Object|Function} options - Options or callback
   * @param {Function} callback - Callback function
   */
  rmdir(path, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }

    path = this.resolvePath(path);

    this[kProvider].rmdir(path)
      .then(() => callback(null))
      .catch((err) => callback(err));
  }

  /**
   * Read directory (callback)
   * @param {string} path - Directory path
   * @param {Object|Function} options - Options or callback
   * @param {Function} callback - Callback function
   */
  readdir(path, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }

    path = this.resolvePath(path);

    this[kProvider].readdir(path, options)
      .then((entries) => callback(null, entries))
      .catch((err) => callback(err));
  }

  /**
   * Delete file (callback)
   * @param {string} path - File path
   * @param {Function} callback - Callback function
   */
  unlink(path, callback) {
    path = this.resolvePath(path);

    this[kProvider].unlink(path)
      .then(() => callback(null))
      .catch((err) => callback(err));
  }

  /**
   * Rename file (callback)
   * @param {string} oldPath - Old path
   * @param {string} newPath - New path
   * @param {Function} callback - Callback function
   */
  rename(oldPath, newPath, callback) {
    oldPath = this.resolvePath(oldPath);
    newPath = this.resolvePath(newPath);

    this[kProvider].rename(oldPath, newPath)
      .then(() => callback(null))
      .catch((err) => callback(err));
  }

  /**
   * Copy file (callback)
   * @param {string} src - Source path
   * @param {string} dest - Destination path
   * @param {number|Function} flags - Flags or callback
   * @param {Function} callback - Callback function
   */
  copyFile(src, dest, flags, callback) {
    if (typeof flags === 'function') {
      callback = flags;
      flags = 0;
    }

    src = this.resolvePath(src);
    dest = this.resolvePath(dest);

    this[kProvider].copyFile(src, dest, flags)
      .then(() => callback(null))
      .catch((err) => callback(err));
  }

  /**
   * Change file mode (callback)
   * @param {string} path - File path
   * @param {number} mode - File mode
   * @param {Function} callback - Callback function
   */
  chmod(path, mode, callback) {
    path = this.resolvePath(path);

    this[kProvider].chmod(path, mode)
      .then(() => callback(null))
      .catch((err) => callback(err));
  }

  /**
   * Change file ownership (callback)
   * @param {string} path - File path
   * @param {number} uid - User ID
   * @param {number} gid - Group ID
   * @param {Function} callback - Callback function
   */
  chown(path, uid, gid, callback) {
    path = this.resolvePath(path);

    this[kProvider].chown(path, uid, gid)
      .then(() => callback(null))
      .catch((err) => callback(err));
  }

  /**
   * Create symbolic link (callback)
   * @param {string} target - Link target
   * @param {string} path - Link path
   * @param {string|Function} type - Link type or callback
   * @param {Function} callback - Callback function
   */
  symlink(target, path, type, callback) {
    if (typeof type === 'function') {
      callback = type;
      type = 'file';
    }

    path = this.resolvePath(path);

    this[kProvider].symlink(target, path, type)
      .then(() => callback(null))
      .catch((err) => callback(err));
  }

  /**
   * Read symbolic link (callback)
   * @param {string} path - Link path
   * @param {Object|Function} options - Options or callback
   * @param {Function} callback - Callback function
   */
  readlink(path, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }

    path = this.resolvePath(path);

    this[kProvider].readlink(path)
      .then((target) => callback(null, target))
      .catch((err) => callback(err));
  }

  /**
   * Create hard link (callback)
   * @param {string} existingPath - Existing file
   * @param {string} newPath - New link
   * @param {Function} callback - Callback function
   */
  link(existingPath, newPath, callback) {
    existingPath = this.resolvePath(existingPath);
    newPath = this.resolvePath(newPath);

    this[kProvider].link(existingPath, newPath)
      .then(() => callback(null))
      .catch((err) => callback(err));
  }

  /**
   * Update file times (callback)
   * @param {string} path - File path
   * @param {number|Date} atime - Access time
   * @param {number|Date} mtime - Modification time
   * @param {Function} callback - Callback function
   */
  utimes(path, atime, mtime, callback) {
    path = this.resolvePath(path);

    this[kProvider].utimes(path, atime, mtime)
      .then(() => callback(null))
      .catch((err) => callback(err));
  }

  /**
   * Resolve real path (callback)
   * @param {string} path - Path to resolve
   * @param {Object|Function} options - Options or callback
   * @param {Function} callback - Callback function
   */
  realpath(path, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }

    path = this.resolvePath(path);

    this[kProvider].realpath(path, options)
      .then((resolved) => callback(null, resolved))
      .catch((err) => callback(err));
  }

  // === SYNC API ===

  readFileSync(path, options = {}) {
    path = this.resolvePath(path);
    return this[kProvider].readFileSync(path, options);
  }

  writeFileSync(path, data, options = {}) {
    path = this.resolvePath(path);
    return this[kProvider].writeFileSync(path, data, options);
  }

  appendFileSync(path, data, options = {}) {
    path = this.resolvePath(path);
    return this[kProvider].appendFileSync(path, data, options);
  }

  statSync(path, options = {}) {
    path = this.resolvePath(path);
    return this[kProvider].statSync(path, options);
  }

  lstatSync(path, options = {}) {
    path = this.resolvePath(path);
    return this[kProvider].statSync(path, { ...options, followSymlinks: false });
  }

  accessSync(path, mode = 0) {
    path = this.resolvePath(path);
    if (!this[kProvider].existsSync(path)) {
      const err = new Error('ENOENT: no such file or directory');
      err.code = 'ENOENT';
      throw err;
    }
  }

  mkdirSync(path, options = {}) {
    path = this.resolvePath(path);
    return this[kProvider].mkdirSync(path, options);
  }

  rmdirSync(path, options = {}) {
    path = this.resolvePath(path);
    return this[kProvider].rmdirSync(path);
  }

  readdirSync(path, options = {}) {
    path = this.resolvePath(path);
    return this[kProvider].readdirSync(path, options);
  }

  unlinkSync(path) {
    path = this.resolvePath(path);
    return this[kProvider].unlinkSync(path);
  }

  renameSync(oldPath, newPath) {
    oldPath = this.resolvePath(oldPath);
    newPath = this.resolvePath(newPath);
    return this[kProvider].renameSync(oldPath, newPath);
  }

  copyFileSync(src, dest, flags = 0) {
    src = this.resolvePath(src);
    dest = this.resolvePath(dest);
    return this[kProvider].copyFileSync(src, dest, flags);
  }

  chmodSync(path, mode) {
    path = this.resolvePath(path);
    return this[kProvider].chmodSync(path, mode);
  }

  chownSync(path, uid, gid) {
    path = this.resolvePath(path);
    return this[kProvider].chownSync(path, uid, gid);
  }

  symlinkSync(target, path, type = 'file') {
    path = this.resolvePath(path);
    return this[kProvider].symlinkSync(target, path, type);
  }

  readlinkSync(path, options = {}) {
    path = this.resolvePath(path);
    return this[kProvider].readlinkSync(path);
  }

  linkSync(existingPath, newPath) {
    existingPath = this.resolvePath(existingPath);
    newPath = this.resolvePath(newPath);
    return this[kProvider].linkSync(existingPath, newPath);
  }

  utimesSync(path, atime, mtime) {
    path = this.resolvePath(path);
    return this[kProvider].utimesSync(path, atime, mtime);
  }

  realpathSync(path, options = {}) {
    path = this.resolvePath(path);
    return this[kProvider].realpathSync(path, options);
  }

  existsSync(path) {
    path = this.resolvePath(path);
    return this[kProvider].existsSync(path);
  }

  // === Stream Methods ===

  createReadStream(path, options) {
    const { VirtualReadStream } = require('internal/fs/vfs/streams');
    path = this.resolvePath(path);
    return new VirtualReadStream(this, path, options);
  }

  createWriteStream(path, options) {
    const { VirtualWriteStream } = require('internal/fs/vfs/streams');
    path = this.resolvePath(path);
    return new VirtualWriteStream(this, path, options);
  }

  // === Watch Methods ===

  watch(filename, options, listener) {
    const path = this.resolvePath(filename);
    return this[kProvider].watch(path, options, listener);
  }

  watchFile(filename, options, listener) {
    const path = this.resolvePath(filename);
    return this[kProvider].watchFile(path, options, listener);
  }

  unwatchFile(filename, listener) {
    const path = this.resolvePath(filename);
    return this[kProvider].unwatchFile(path, listener);
  }

  // === Factory Methods ===

  /**
   * Create VFS with memory provider
   * @param {Object} options - Options
   * @returns {VirtualFileSystem}
   */
  static memory(options = {}) {
    const { MemoryProvider } = require('internal/fs/vfs/providers/memory');
    return new VirtualFileSystem(new MemoryProvider(), options.cwd);
  }

  /**
   * Create VFS with local provider
   * @param {Object} options - Options
   * @returns {VirtualFileSystem}
   */
  static local(options = {}) {
    const { LocalProvider } = require('internal/fs/vfs/providers/local');
    return new VirtualFileSystem(new LocalProvider(), options.cwd);
  }

  /**
   * Create VFS with S3 provider
   * @param {Object} options - S3 options
   * @returns {VirtualFileSystem}
   */
  static s3(options) {
    const { S3Provider } = require('internal/fs/vfs/providers/s3');
    return new VirtualFileSystem(new S3Provider(options), options.cwd);
  }
}

/**
 * VirtualPromises - Promises API for VFS
 */
class VirtualPromises {
  constructor(vfs) {
    this.vfs = vfs;
  }

  get provider() {
    return this.vfs[kProvider];
  }

  async readFile(path, options = {}) {
    path = this.vfs.resolvePath(path);
    return await this.provider.readFile(path, options);
  }

  async writeFile(path, data, options = {}) {
    path = this.vfs.resolvePath(path);
    return await this.provider.writeFile(path, data, options);
  }

  async appendFile(path, data, options = {}) {
    path = this.vfs.resolvePath(path);
    return await this.provider.appendFile(path, data, options);
  }

  async stat(path, options = {}) {
    path = this.vfs.resolvePath(path);
    return await this.provider.stat(path, options);
  }

  async lstat(path, options = {}) {
    path = this.vfs.resolvePath(path);
    return await this.provider.stat(path, { ...options, followSymlinks: false });
  }

  async access(path, mode = 0) {
    path = this.vfs.resolvePath(path);
    const exists = await this.provider.exists(path);
    if (!exists) {
      const err = new Error('ENOENT: no such file or directory');
      err.code = 'ENOENT';
      throw err;
    }
  }

  async mkdir(path, options = {}) {
    path = this.vfs.resolvePath(path);
    return await this.provider.mkdir(path, options);
  }

  async rmdir(path, options = {}) {
    path = this.vfs.resolvePath(path);
    return await this.provider.rmdir(path);
  }

  async readdir(path, options = {}) {
    path = this.vfs.resolvePath(path);
    return await this.provider.readdir(path, options);
  }

  async unlink(path) {
    path = this.vfs.resolvePath(path);
    return await this.provider.unlink(path);
  }

  async rename(oldPath, newPath) {
    oldPath = this.vfs.resolvePath(oldPath);
    newPath = this.vfs.resolvePath(newPath);
    return await this.provider.rename(oldPath, newPath);
  }

  async copyFile(src, dest, flags = 0) {
    src = this.vfs.resolvePath(src);
    dest = this.vfs.resolvePath(dest);
    return await this.provider.copyFile(src, dest, flags);
  }

  async chmod(path, mode) {
    path = this.vfs.resolvePath(path);
    return await this.provider.chmod(path, mode);
  }

  async chown(path, uid, gid) {
    path = this.vfs.resolvePath(path);
    return await this.provider.chown(path, uid, gid);
  }

  async symlink(target, path, type = 'file') {
    path = this.vfs.resolvePath(path);
    return await this.provider.symlink(target, path, type);
  }

  async readlink(path, options = {}) {
    path = this.vfs.resolvePath(path);
    return await this.provider.readlink(path);
  }

  async link(existingPath, newPath) {
    existingPath = this.vfs.resolvePath(existingPath);
    newPath = this.vfs.resolvePath(newPath);
    return await this.provider.link(existingPath, newPath);
  }

  async utimes(path, atime, mtime) {
    path = this.vfs.resolvePath(path);
    return await this.provider.utimes(path, atime, mtime);
  }

  async realpath(path, options = {}) {
    path = this.vfs.resolvePath(path);
    return await this.provider.realpath(path, options);
  }

  async open(path, flags = 'r', mode = 0o666) {
    path = this.vfs.resolvePath(path);
    const numericFlags = typeof flags === 'string' ? stringToFlags(flags) : flags;
    const handle = await this.provider.open(path, numericFlags, mode);
    return new VirtualFileHandle(this.provider, path, numericFlags, mode, handle);
  }
}

module.exports = {
  VirtualFileSystem,
  VirtualPromises,
};
