'use strict';

const {
  Map,
  Set,
  SafeMap,
  SafeSet,
} = primordials;

const pathModule = require('path');
const { Buffer } = require('buffer');
const { VirtualProvider } = require('internal/fs/vfs/provider');
const { createVirtualStats } = require('internal/fs/vfs/stats');
const { createVirtualDirent } = require('internal/fs/vfs/dirent');
const {
  ENOENT,
  EEXIST,
  EISDIR,
  ENOTDIR,
  ENOTEMPTY,
  ELOOP,
} = require('internal/fs/vfs/errors');

const {
  S_IFMT,
  S_IFREG,
  S_IFDIR,
  S_IFLNK,
  O_RDONLY,
  O_WRONLY,
  O_RDWR,
  O_CREAT,
  O_EXCL,
  O_TRUNC,
  O_APPEND,
} = internalBinding('constants').fs;

// In-memory file with reference counting for hard links
class MemFile {
  constructor(content = Buffer.allocUnsafe(0), mode = 0o644) {
    this.content = content;
    this.mode = mode;
    this.atime = Date.now();
    this.mtime = Date.now();
    this.ctime = Date.now();
    this.linkCount = 1;
  }
}

// File handle for memory files
class MemoryFileHandle {
  constructor(buffer, path, provider, flags, mode) {
    this.buffer = buffer;
    this.path = path;
    this.provider = provider;
    this.flags = flags;
    this.mode = mode;
    this.position = 0;
    this.closed = false;
    this.fd = -1; // Virtual fd
  }

  async read(buffer, offset, length, position) {
    if (this.closed) throw new Error('File handle closed');

    const pos = position !== null && position !== undefined ? position : this.position;
    const available = this.buffer.length - pos;
    const toRead = Math.min(length, available);

    if (toRead <= 0) return 0;

    this.buffer.copy(buffer, offset, pos, pos + toRead);

    if (position === null || position === undefined) {
      this.position += toRead;
    }

    return toRead;
  }

  readSync(buffer, offset, length, position) {
    if (this.closed) throw new Error('File handle closed');

    const pos = position !== null && position !== undefined ? position : this.position;
    const available = this.buffer.length - pos;
    const toRead = Math.min(length, available);

    if (toRead <= 0) return 0;

    this.buffer.copy(buffer, offset, pos, pos + toRead);

    if (position === null || position === undefined) {
      this.position += toRead;
    }

    return toRead;
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

  writeSync(buffer, offset, length, position) {
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

  async truncate(len) {
    if (this.closed) throw new Error('File handle closed');

    if (len < this.buffer.length) {
      this.buffer = this.buffer.subarray(0, len);
    } else if (len > this.buffer.length) {
      const newBuffer = Buffer.allocUnsafe(len);
      this.buffer.copy(newBuffer, 0, 0, this.buffer.length);
      this.buffer = newBuffer;
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;

    // Save content back to provider
    await this.provider.saveFile(this.path, this.buffer, this.mode);
  }

  closeSync() {
    if (this.closed) return;
    this.closed = true;

    // Save content back to provider
    this.provider.saveFileSync(this.path, this.buffer, this.mode);
  }
}

/**
 * MemoryProvider - In-memory filesystem with inode-based hard links
 */
class MemoryProvider extends VirtualProvider {
  constructor() {
    super();

    this._inodes = new Map();           // inode -> MemFile
    this._fileInodes = new Map();       // path -> inode
    this._symlinks = new Map();         // path -> target
    this._dirs = new Set();             // Set of directory paths
    this._dirChildren = new Map();      // path -> Set of basenames
    this._nextInode = 1;

    // Root directory always exists
    this._dirs.add('/');
    this._dirChildren.set('/', new Set());
  }

  // === CAPABILITY OVERRIDES ===

  get supportsSymlinks() {
    return true;
  }

  get supportsHardLinks() {
    return true;
  }

  get supportsChown() {
    return false; // No-op for memory filesystem
  }

  get supportsLocking() {
    return false;
  }

  get supportsFsync() {
    return false;
  }

  // === PRIMITIVES ===

  async open(path, flags, mode) {
    return this.openSync(path, flags, mode);
  }

  openSync(path, flags, mode) {
    const key = this._normalizePath(path);

    // Check if creating new file
    const isCreate = (flags & O_CREAT) !== 0;
    const isExclusive = (flags & O_EXCL) !== 0;
    const isTruncate = (flags & O_TRUNC) !== 0;
    const isAppend = (flags & O_APPEND) !== 0;
    const isReadOnly = (flags & O_ACCMODE) === O_RDONLY;
    const isWriteOnly = (flags & O_ACCMODE) === O_WRONLY;
    const isReadWrite = (flags & O_ACCMODE) === O_RDWR;

    // Resolve symlinks
    const resolvedKey = this._resolveSymlinks(key);

    // Check if file exists
    const inodeNum = this._fileInodes.get(resolvedKey);
    const exists = inodeNum !== undefined;

    if (isExclusive && isCreate && exists) {
      throw EEXIST('open', path);
    }

    if (!exists && !isCreate) {
      throw ENOENT('open', path);
    }

    let buffer;
    if (exists && !isTruncate) {
      // Open existing file
      const memFile = this._inodes.get(inodeNum);
      buffer = Buffer.from(memFile.content);

      if (isAppend) {
        // Start at end for append
        const handle = new MemoryFileHandle(buffer, key, this, flags, mode || memFile.mode);
        handle.position = buffer.length;
        return handle;
      }
    } else {
      // Create new file or truncate
      this._ensureParentDirs(key);
      buffer = Buffer.allocUnsafe(0);
    }

    return new MemoryFileHandle(buffer, key, this, flags, mode || 0o666);
  }

  async stat(path, options = {}) {
    return this.statSync(path, options);
  }

  statSync(path, options = {}) {
    const followSymlinks = options.followSymlinks !== false;
    const key = this._normalizePath(path);

    // Check if it's a symlink
    if (this._symlinks.has(key)) {
      if (followSymlinks) {
        const resolvedKey = this._resolveSymlinks(key);
        return this.statSync(resolvedKey, { followSymlinks: true });
      } else {
        // Return stats for the symlink itself
        const target = this._symlinks.get(key);
        return createVirtualStats({
          dev: 0,
          mode: S_IFLNK | 0o777,
          nlink: 1,
          uid: 0,
          gid: 0,
          rdev: 0,
          blksize: 4096,
          ino: 0,
          size: Buffer.byteLength(target),
          blocks: 0,
        });
      }
    }

    // Check if it's a file
    const inodeNum = this._fileInodes.get(key);
    if (inodeNum !== undefined) {
      const memFile = this._inodes.get(inodeNum);
      return createVirtualStats({
        dev: 0,
        mode: S_IFREG | memFile.mode,
        nlink: memFile.linkCount,
        uid: 0,
        gid: 0,
        rdev: 0,
        blksize: 4096,
        ino: inodeNum,
        size: memFile.content.length,
        blocks: Math.ceil(memFile.content.length / 512),
        atimeMs: memFile.atime,
        mtimeMs: memFile.mtime,
        ctimeMs: memFile.ctime,
        birthtimeMs: memFile.ctime,
      });
    }

    // Check if it's a directory
    if (this._dirs.has(key)) {
      return createVirtualStats({
        dev: 0,
        mode: S_IFDIR | 0o755,
        nlink: 2,
        uid: 0,
        gid: 0,
        rdev: 0,
        blksize: 4096,
        ino: 0,
        size: 4096,
        blocks: 8,
      });
    }

    throw ENOENT('stat', path);
  }

  async unlink(path) {
    return this.unlinkSync(path);
  }

  unlinkSync(path) {
    const key = this._normalizePath(path);

    // If it's a symlink, just delete the symlink
    if (this._symlinks.has(key)) {
      this._symlinks.delete(key);
      this._removeFromParent(key);
      return;
    }

    // Otherwise delete the file
    const inodeNum = this._fileInodes.get(key);
    if (inodeNum === undefined) {
      throw ENOENT('unlink', path);
    }

    const memFile = this._inodes.get(inodeNum);
    memFile.linkCount -= 1;

    // Only delete inode data if no more links
    if (memFile.linkCount <= 0) {
      this._inodes.delete(inodeNum);
    }

    this._fileInodes.delete(key);
    this._removeFromParent(key);
  }

  async rename(oldPath, newPath) {
    return this.renameSync(oldPath, newPath);
  }

  renameSync(oldPath, newPath) {
    const oldKey = this._normalizePath(oldPath);
    const newKey = this._normalizePath(newPath);

    // Handle symlink rename
    const target = this._symlinks.get(oldKey);
    if (target !== undefined) {
      this._ensureParentDirs(newKey);
      this._symlinks.set(newKey, target);
      this._symlinks.delete(oldKey);
      this._removeFromParent(oldKey);
      this._addToParent(newKey);
      return;
    }

    // Handle file rename
    const inodeNum = this._fileInodes.get(oldKey);
    if (inodeNum === undefined) {
      throw ENOENT('rename', oldPath);
    }

    this._ensureParentDirs(newKey);
    this._fileInodes.set(newKey, inodeNum);
    this._fileInodes.delete(oldKey);

    this._removeFromParent(oldKey);
    this._addToParent(newKey);
  }

  async chmod(path, mode) {
    return this.chmodSync(path, mode);
  }

  chmodSync(path, mode) {
    const key = this._normalizePath(path);
    const resolvedKey = this._resolveSymlinks(key);
    const inodeNum = this._fileInodes.get(resolvedKey);

    if (inodeNum === undefined) {
      throw ENOENT('chmod', path);
    }

    const memFile = this._inodes.get(inodeNum);
    memFile.mode = mode & 0o777;
  }

  async chown(path, uid, gid) {
    return this.chownSync(path, uid, gid);
  }

  chownSync(path, uid, gid) {
    // No-op for memory filesystem
  }

  async utimes(path, atime, mtime) {
    return this.utimesSync(path, atime, mtime);
  }

  utimesSync(path, atime, mtime) {
    const key = this._normalizePath(path);
    const resolvedKey = this._resolveSymlinks(key);
    const inodeNum = this._fileInodes.get(resolvedKey);

    if (inodeNum === undefined) {
      throw ENOENT('utimes', path);
    }

    const memFile = this._inodes.get(inodeNum);
    memFile.atime = atime instanceof Date ? atime.getTime() : atime;
    memFile.mtime = mtime instanceof Date ? mtime.getTime() : mtime;
  }

  async link(existingPath, newPath) {
    return this.linkSync(existingPath, newPath);
  }

  linkSync(existingPath, newPath) {
    const existingKey = this._normalizePath(existingPath);
    const newKey = this._normalizePath(newPath);

    // Follow symlinks to find the actual file
    const resolvedExisting = this._resolveSymlinks(existingKey);

    // Get the inode for the existing file
    const inodeNum = this._fileInodes.get(resolvedExisting);
    if (inodeNum === undefined) {
      throw ENOENT('link', existingPath);
    }

    // Create new link pointing to same inode
    this._ensureParentDirs(newKey);
    this._fileInodes.set(newKey, inodeNum);

    // Increment link count
    const memFile = this._inodes.get(inodeNum);
    memFile.linkCount += 1;

    this._addToParent(newKey);
  }

  async symlink(target, path, type) {
    return this.symlinkSync(target, path, type);
  }

  symlinkSync(target, path, type) {
    const key = this._normalizePath(path);

    // Store the target path as-is (can be relative or absolute)
    this._ensureParentDirs(key);
    this._symlinks.set(key, target);

    this._addToParent(key);
  }

  async readlink(path) {
    return this.readlinkSync(path);
  }

  readlinkSync(path) {
    const key = this._normalizePath(path);
    const target = this._symlinks.get(key);

    if (target === undefined) {
      throw ENOENT('readlink', path);
    }

    return target;
  }

  async mkdir(path, options = {}) {
    return this.mkdirSync(path, options);
  }

  mkdirSync(path, options = {}) {
    const recursive = options.recursive || false;
    const mode = options.mode || 0o777;
    const key = this._normalizePath(path);

    if (this._dirs.has(key)) {
      if (!recursive) {
        throw EEXIST('mkdir', path);
      }
      return undefined;
    }

    if (recursive) {
      this._mkdirp(key, mode);
      return undefined;
    }

    this._ensureParentDirs(key);
    this._dirs.add(key);
    this._dirChildren.set(key, new Set());
    this._addToParent(key);

    return undefined;
  }

  async rmdir(path) {
    return this.rmdirSync(path);
  }

  rmdirSync(path) {
    const key = this._normalizePath(path);

    if (!this._dirs.has(key)) {
      throw ENOENT('rmdir', path);
    }

    // Check if directory is empty
    const children = this._dirChildren.get(key);
    if (children && children.size > 0) {
      throw ENOTEMPTY('rmdir', path);
    }

    this._dirs.delete(key);
    this._dirChildren.delete(key);
    this._removeFromParent(key);
  }

  async readdir(path, options = {}) {
    return this.readdirSync(path, options);
  }

  readdirSync(path, options = {}) {
    const key = this._normalizePath(path);
    const withFileTypes = options.withFileTypes || false;

    if (!this._dirs.has(key)) {
      throw ENOTDIR('readdir', path);
    }

    const children = this._dirChildren.get(key) || new Set();
    const entries = Array.from(children);

    if (withFileTypes) {
      return entries.map((name) => {
        const childPath = pathModule.join(key, name);
        try {
          const stats = this.statSync(childPath, { followSymlinks: false });
          return createVirtualDirent(name, stats, key);
        } catch {
          // Shouldn't happen, but return unknown type if it does
          return createVirtualDirent(name, createVirtualStats({ mode: 0 }), key);
        }
      });
    }

    return entries;
  }

  tmpdir() {
    // Ensure /tmp exists
    if (!this._dirs.has('/tmp')) {
      this._dirs.add('/tmp');
      this._dirChildren.set('/tmp', new Set());
    }
    return '/tmp';
  }

  // === HELPER METHODS ===

  _normalizePath(path) {
    const normalized = pathModule.normalize(path);
    return normalized === '.' || normalized === '' ? '/' : normalized;
  }

  _resolveSymlinks(path, maxDepth = 40) {
    let resolved = path;
    let depth = 0;

    while (this._symlinks.has(resolved) && depth < maxDepth) {
      const target = this._symlinks.get(resolved);

      // Handle relative symlinks
      if (pathModule.isAbsolute(target)) {
        resolved = this._normalizePath(target);
      } else {
        const parent = pathModule.dirname(resolved);
        resolved = this._normalizePath(pathModule.join(parent, target));
      }

      depth += 1;
    }

    if (depth >= maxDepth && this._symlinks.has(resolved)) {
      throw ELOOP('readlink', path);
    }

    return resolved;
  }

  _ensureParentDirs(path) {
    const parent = pathModule.dirname(path);
    if (parent === '/' || parent === '.') return;

    if (!this._dirs.has(parent)) {
      this._ensureParentDirs(parent);
      this._dirs.add(parent);
      this._dirChildren.set(parent, new Set());
      this._addToParent(parent);
    }
  }

  _mkdirp(path, mode) {
    if (this._dirs.has(path)) return;

    const pathsToCreate = [];
    let current = path;

    while (current && current !== '/') {
      if (this._dirs.has(current)) break;
      pathsToCreate.push(current);
      current = pathModule.dirname(current);
    }

    // Create directories bottom-up (parent first)
    for (let i = pathsToCreate.length - 1; i >= 0; i--) {
      const pathToCreate = pathsToCreate[i];
      this._dirs.add(pathToCreate);
      this._dirChildren.set(pathToCreate, new Set());
      this._addToParent(pathToCreate);
    }
  }

  _addToParent(path) {
    if (path === '/') return;

    const parent = pathModule.dirname(path);
    const basename = pathModule.basename(path);

    if (!this._dirChildren.has(parent)) {
      this._dirChildren.set(parent, new Set());
    }

    this._dirChildren.get(parent).add(basename);
  }

  _removeFromParent(path) {
    if (path === '/') return;

    const parent = pathModule.dirname(path);
    const basename = pathModule.basename(path);
    const children = this._dirChildren.get(parent);

    if (children) {
      children.delete(basename);
    }
  }

  async saveFile(path, content, mode) {
    return this.saveFileSync(path, content, mode);
  }

  saveFileSync(path, content, mode) {
    const inodeNum = this._fileInodes.get(path);

    if (inodeNum !== undefined) {
      // Updating existing file
      const memFile = this._inodes.get(inodeNum);
      memFile.content = content;
      memFile.mtime = Date.now();
      memFile.mode = mode || memFile.mode;
    } else {
      // Creating new file
      const newInodeNum = this._nextInode++;
      const memFile = new MemFile(content, mode || 0o644);
      this._inodes.set(newInodeNum, memFile);
      this._fileInodes.set(path, newInodeNum);
      this._addToParent(path);
    }
  }
}

const O_ACCMODE = 3; // Mask for access mode

module.exports = {
  MemoryProvider,
};
