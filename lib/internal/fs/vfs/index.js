'use strict';

// Main VFS exports
const { VirtualFileSystem, VirtualPromises } = require('internal/fs/vfs/file_system');
const { VirtualProvider } = require('internal/fs/vfs/provider');
const { VirtualStats, createVirtualStats } = require('internal/fs/vfs/stats');
const { VirtualDirent, createVirtualDirent } = require('internal/fs/vfs/dirent');
const { VirtualFileHandle, VirtualFileHandleSync } = require('internal/fs/vfs/file_handle');
const { VirtualReadStream, VirtualWriteStream } = require('internal/fs/vfs/streams');
const {
  VirtualError,
  ReadOnlyError,
  createError,
  ENOENT,
  EEXIST,
  EISDIR,
  ENOTDIR,
  ENOTEMPTY,
  EACCES,
  EPERM,
  EROFS,
  EINVAL,
  EMFILE,
  EBADF,
  ELOOP,
} = require('internal/fs/vfs/errors');

module.exports = {
  // Main classes
  VirtualFileSystem,
  VirtualPromises,
  VirtualProvider,
  VirtualStats,
  VirtualDirent,
  VirtualFileHandle,
  VirtualFileHandleSync,
  VirtualReadStream,
  VirtualWriteStream,

  // Errors
  VirtualError,
  ReadOnlyError,
  createError,
  ENOENT,
  EEXIST,
  EISDIR,
  ENOTDIR,
  ENOTEMPTY,
  EACCES,
  EPERM,
  EROFS,
  EINVAL,
  EMFILE,
  EBADF,
  ELOOP,

  // Factories
  createVirtualStats,
  createVirtualDirent,
};
