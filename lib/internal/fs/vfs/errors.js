'use strict';

const { codes } = require('internal/errors');
const { SystemError } = require('internal/errors');

class VirtualError extends Error {
  constructor(message, { code, syscall, path, dest, errno } = {}) {
    super(message);
    this.name = 'VirtualError';

    if (code) this.code = code;
    if (syscall) this.syscall = syscall;
    if (path !== undefined) this.path = path;
    if (dest !== undefined) this.dest = dest;
    if (errno !== undefined) this.errno = errno;

    Error.captureStackTrace(this, this.constructor);
  }
}

class ReadOnlyError extends VirtualError {
  constructor(operation, path) {
    const message = path
      ? `Cannot ${operation}: ${path} (read-only filesystem)`
      : `Cannot ${operation}: read-only filesystem`;
    super(message, { code: 'EROFS', syscall: operation, path });
    this.name = 'ReadOnlyError';
  }
}

// Error factory functions matching Node.js fs error patterns
function createError(code, syscall, path, dest) {
  const messages = {
    'ENOENT': path => dest
      ? `${syscall} '${path}' -> '${dest}'`
      : `${syscall} '${path}'`,
    'EEXIST': path => `file already exists, ${syscall} '${path}'`,
    'EISDIR': path => `illegal operation on a directory, ${syscall} '${path}'`,
    'ENOTDIR': path => `not a directory, ${syscall} '${path}'`,
    'ENOTEMPTY': path => `directory not empty, ${syscall} '${path}'`,
    'EACCES': path => `permission denied, ${syscall} '${path}'`,
    'EPERM': path => `operation not permitted, ${syscall} '${path}'`,
    'EINVAL': path => `invalid argument, ${syscall} '${path}'`,
    'EMFILE': () => `too many open files, ${syscall}`,
    'EBADF': () => `bad file descriptor, ${syscall}`,
    'ELOOP': path => `too many symbolic links encountered, ${syscall} '${path}'`,
  };

  const messageGenerator = messages[code];
  const message = messageGenerator ? messageGenerator(path) : `${code}: ${syscall} '${path}'`;

  const error = new VirtualError(message, { code, syscall, path, dest });
  error.errno = getErrno(code);
  return error;
}

// Map error codes to errno values (negative values matching system errnos)
function getErrno(code) {
  const errnos = {
    'ENOENT': -2,
    'EEXIST': -17,
    'EISDIR': -21,
    'ENOTDIR': -20,
    'ENOTEMPTY': -39,
    'EACCES': -13,
    'EPERM': -1,
    'EROFS': -30,
    'EINVAL': -22,
    'EMFILE': -24,
    'EBADF': -9,
    'ELOOP': -62,
  };
  return errnos[code] || -1;
}

function errnoException(errno, syscall, path, dest) {
  const code = getCodeFromErrno(errno);
  return createError(code, syscall, path, dest);
}

function getCodeFromErrno(errno) {
  const codes = {
    '-2': 'ENOENT',
    '-17': 'EEXIST',
    '-21': 'EISDIR',
    '-20': 'ENOTDIR',
    '-39': 'ENOTEMPTY',
    '-13': 'EACCES',
    '-1': 'EPERM',
    '-30': 'EROFS',
    '-22': 'EINVAL',
    '-24': 'EMFILE',
    '-9': 'EBADF',
    '-62': 'ELOOP',
  };
  return codes[String(errno)] || 'UNKNOWN';
}

// Specific error creators
const ENOENT = (syscall, path, dest) => createError('ENOENT', syscall, path, dest);
const EEXIST = (syscall, path) => createError('EEXIST', syscall, path);
const EISDIR = (syscall, path) => createError('EISDIR', syscall, path);
const ENOTDIR = (syscall, path) => createError('ENOTDIR', syscall, path);
const ENOTEMPTY = (syscall, path) => createError('ENOTEMPTY', syscall, path);
const EACCES = (syscall, path) => createError('EACCES', syscall, path);
const EPERM = (syscall, path) => createError('EPERM', syscall, path);
const EROFS = (syscall, path) => createError('EROFS', syscall, path);
const EINVAL = (syscall, path) => createError('EINVAL', syscall, path);
const EMFILE = (syscall) => createError('EMFILE', syscall);
const EBADF = (syscall) => createError('EBADF', syscall);
const ELOOP = (syscall, path) => createError('ELOOP', syscall, path);

module.exports = {
  VirtualError,
  ReadOnlyError,
  createError,
  errnoException,
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
};
