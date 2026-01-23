'use strict';

const fs = require('fs');
const { VirtualProvider } = require('internal/fs/vfs/provider');
const { createVirtualStats } = require('internal/fs/vfs/stats');
const { createVirtualDirent } = require('internal/fs/vfs/dirent');

const {
  S_IFMT,
  S_IFREG,
  S_IFDIR,
  S_IFLNK,
} = internalBinding('constants').fs;

// File handle wrapper for native fs file descriptors
class LocalFileHandle {
  constructor(fd, path) {
    this.fd = fd;
    this.path = path;
    this.closed = false;
  }

  async read(buffer, offset, length, position) {
    if (this.closed) throw new Error('File handle closed');
    const result = await fs.promises.read(this.fd, buffer, offset, length, position);
    return result.bytesRead;
  }

  readSync(buffer, offset, length, position) {
    if (this.closed) throw new Error('File handle closed');
    return fs.readSync(this.fd, buffer, offset, length, position);
  }

  async write(buffer, offset, length, position) {
    if (this.closed) throw new Error('File handle closed');
    const result = await fs.promises.write(this.fd, buffer, offset, length, position);
    return result.bytesWritten;
  }

  writeSync(buffer, offset, length, position) {
    if (this.closed) throw new Error('File handle closed');
    return fs.writeSync(this.fd, buffer, offset, length, position);
  }

  async truncate(len) {
    if (this.closed) throw new Error('File handle closed');
    return await fs.promises.ftruncate(this.fd, len);
  }

  async stat() {
    if (this.closed) throw new Error('File handle closed');
    const stats = await fs.promises.fstat(this.fd);
    return convertStats(stats);
  }

  async chmod(mode) {
    if (this.closed) throw new Error('File handle closed');
    return await fs.promises.fchmod(this.fd, mode);
  }

  async chown(uid, gid) {
    if (this.closed) throw new Error('File handle closed');
    return await fs.promises.fchown(this.fd, uid, gid);
  }

  async utimes(atime, mtime) {
    if (this.closed) throw new Error('File handle closed');
    return await fs.promises.futimes(this.fd, atime, mtime);
  }

  async sync() {
    if (this.closed) throw new Error('File handle closed');
    return await fs.promises.fsync(this.fd);
  }

  async datasync() {
    if (this.closed) throw new Error('File handle closed');
    return await fs.promises.fdatasync(this.fd);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    return await fs.promises.close(this.fd);
  }

  closeSync() {
    if (this.closed) return;
    this.closed = true;
    fs.closeSync(this.fd);
  }
}

// Convert fs.Stats to VirtualStats
function convertStats(stats) {
  return createVirtualStats({
    dev: stats.dev,
    mode: stats.mode,
    nlink: stats.nlink,
    uid: stats.uid,
    gid: stats.gid,
    rdev: stats.rdev,
    blksize: stats.blksize,
    ino: stats.ino,
    size: stats.size,
    blocks: stats.blocks,
    atimeMs: stats.atimeMs,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
    birthtimeMs: stats.birthtimeMs,
  });
}

/**
 * LocalProvider - Wraps Node.js fs for local filesystem access
 * Delegates all operations to native fs module
 */
class LocalProvider extends VirtualProvider {
  constructor() {
    super();
  }

  // === CAPABILITY OVERRIDES ===

  get supportsSymlinks() {
    return true;
  }

  get supportsHardLinks() {
    return true;
  }

  get supportsChown() {
    return true;
  }

  get supportsLocking() {
    return true;
  }

  get supportsFsync() {
    return true;
  }

  get supportsWatch() {
    return true;
  }

  // === PRIMITIVES ===

  async open(path, flags, mode) {
    const fd = await fs.promises.open(path, flags, mode);
    return new LocalFileHandle(fd.fd, path);
  }

  openSync(path, flags, mode) {
    const fd = fs.openSync(path, flags, mode);
    return new LocalFileHandle(fd, path);
  }

  async stat(path, options = {}) {
    const followSymlinks = options.followSymlinks !== false;
    const stats = followSymlinks
      ? await fs.promises.stat(path)
      : await fs.promises.lstat(path);
    return convertStats(stats);
  }

  statSync(path, options = {}) {
    const followSymlinks = options.followSymlinks !== false;
    const stats = followSymlinks
      ? fs.statSync(path)
      : fs.lstatSync(path);
    return convertStats(stats);
  }

  async unlink(path) {
    return await fs.promises.unlink(path);
  }

  unlinkSync(path) {
    return fs.unlinkSync(path);
  }

  async rename(oldPath, newPath) {
    return await fs.promises.rename(oldPath, newPath);
  }

  renameSync(oldPath, newPath) {
    return fs.renameSync(oldPath, newPath);
  }

  async chmod(path, mode) {
    return await fs.promises.chmod(path, mode);
  }

  chmodSync(path, mode) {
    return fs.chmodSync(path, mode);
  }

  async chown(path, uid, gid) {
    return await fs.promises.chown(path, uid, gid);
  }

  chownSync(path, uid, gid) {
    return fs.chownSync(path, uid, gid);
  }

  async utimes(path, atime, mtime) {
    return await fs.promises.utimes(path, atime, mtime);
  }

  utimesSync(path, atime, mtime) {
    return fs.utimesSync(path, atime, mtime);
  }

  async link(existingPath, newPath) {
    return await fs.promises.link(existingPath, newPath);
  }

  linkSync(existingPath, newPath) {
    return fs.linkSync(existingPath, newPath);
  }

  async symlink(target, path, type) {
    return await fs.promises.symlink(target, path, type);
  }

  symlinkSync(target, path, type) {
    return fs.symlinkSync(target, path, type);
  }

  async readlink(path) {
    return await fs.promises.readlink(path);
  }

  readlinkSync(path) {
    return fs.readlinkSync(path);
  }

  async mkdir(path, options = {}) {
    return await fs.promises.mkdir(path, options);
  }

  mkdirSync(path, options = {}) {
    return fs.mkdirSync(path, options);
  }

  async rmdir(path) {
    return await fs.promises.rmdir(path);
  }

  rmdirSync(path) {
    return fs.rmdirSync(path);
  }

  async readdir(path, options = {}) {
    const withFileTypes = options.withFileTypes || false;
    const entries = await fs.promises.readdir(path, options);

    if (withFileTypes) {
      // Convert fs.Dirent to VirtualDirent
      return entries.map((dirent) => {
        const stats = createVirtualStats({
          mode: dirent.isDirectory() ? S_IFDIR | 0o755 :
                dirent.isFile() ? S_IFREG | 0o644 :
                dirent.isSymbolicLink() ? S_IFLNK | 0o777 : 0,
        });
        return createVirtualDirent(dirent.name, stats, path);
      });
    }

    return entries;
  }

  readdirSync(path, options = {}) {
    const withFileTypes = options.withFileTypes || false;
    const entries = fs.readdirSync(path, options);

    if (withFileTypes) {
      // Convert fs.Dirent to VirtualDirent
      return entries.map((dirent) => {
        const stats = createVirtualStats({
          mode: dirent.isDirectory() ? S_IFDIR | 0o755 :
                dirent.isFile() ? S_IFREG | 0o644 :
                dirent.isSymbolicLink() ? S_IFLNK | 0o777 : 0,
        });
        return createVirtualDirent(dirent.name, stats, path);
      });
    }

    return entries;
  }

  tmpdir() {
    return require('os').tmpdir();
  }

  // Optional watch support
  watch(path, options) {
    return fs.watch(path, options);
  }

  watchFile(path, options, listener) {
    return fs.watchFile(path, options, listener);
  }

  unwatchFile(path, listener) {
    return fs.unwatchFile(path, listener);
  }
}

module.exports = {
  LocalProvider,
};
