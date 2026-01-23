'use strict';

const {
  ObjectDefineProperties,
  ObjectSetPrototypeOf,
  MathRound,
  Number,
} = primordials;

const { isWindows } = require('internal/util');

const {
  S_IFBLK,
  S_IFCHR,
  S_IFDIR,
  S_IFIFO,
  S_IFLNK,
  S_IFMT,
  S_IFREG,
  S_IFSOCK,
} = internalBinding('constants').fs;

const kNsPerMs = 1_000_000;
const kMsPerSec = 1_000;

function dateFromMs(ms) {
  return new Date(MathRound(Number(ms)));
}

const lazyDateFields = {
  __proto__: null,
  atime: {
    __proto__: null,
    enumerable: true,
    configurable: true,
    get() {
      return this.atime = dateFromMs(this.atimeMs);
    },
    set(value) {
      ObjectDefineProperty(this, 'atime', { __proto__: null, value, writable: true });
    },
  },
  mtime: {
    __proto__: null,
    enumerable: true,
    configurable: true,
    get() {
      return this.mtime = dateFromMs(this.mtimeMs);
    },
    set(value) {
      ObjectDefineProperty(this, 'mtime', { __proto__: null, value, writable: true });
    },
  },
  ctime: {
    __proto__: null,
    enumerable: true,
    configurable: true,
    get() {
      return this.ctime = dateFromMs(this.ctimeMs);
    },
    set(value) {
      ObjectDefineProperty(this, 'ctime', { __proto__: null, value, writable: true });
    },
  },
  birthtime: {
    __proto__: null,
    enumerable: true,
    configurable: true,
    get() {
      return this.birthtime = dateFromMs(this.birthtimeMs);
    },
    set(value) {
      ObjectDefineProperty(this, 'birthtime', { __proto__: null, value, writable: true });
    },
  },
};

// Base class for Virtual stats
function VirtualStatsBase(dev, mode, nlink, uid, gid, rdev, blksize, ino, size, blocks) {
  this.dev = dev;
  this.mode = mode;
  this.nlink = nlink;
  this.uid = uid;
  this.gid = gid;
  this.rdev = rdev;
  this.blksize = blksize;
  this.ino = ino;
  this.size = size;
  this.blocks = blocks;
}

VirtualStatsBase.prototype._checkModeProperty = function(property) {
  if (isWindows && (property === S_IFIFO || property === S_IFBLK || property === S_IFSOCK)) {
    return false;  // Some types are not available on Windows
  }
  return (this.mode & S_IFMT) === property;
};

VirtualStatsBase.prototype.isDirectory = function() {
  return this._checkModeProperty(S_IFDIR);
};

VirtualStatsBase.prototype.isFile = function() {
  return this._checkModeProperty(S_IFREG);
};

VirtualStatsBase.prototype.isBlockDevice = function() {
  return this._checkModeProperty(S_IFBLK);
};

VirtualStatsBase.prototype.isCharacterDevice = function() {
  return this._checkModeProperty(S_IFCHR);
};

VirtualStatsBase.prototype.isSymbolicLink = function() {
  return this._checkModeProperty(S_IFLNK);
};

VirtualStatsBase.prototype.isFIFO = function() {
  return this._checkModeProperty(S_IFIFO);
};

VirtualStatsBase.prototype.isSocket = function() {
  return this._checkModeProperty(S_IFSOCK);
};

// VirtualStats class compatible with fs.Stats
function VirtualStats(dev, mode, nlink, uid, gid, rdev, blksize, ino, size, blocks,
                  atimeMs, mtimeMs, ctimeMs, birthtimeMs) {
  VirtualStatsBase.call(this, dev, mode, nlink, uid, gid, rdev, blksize, ino, size, blocks);
  this.atimeMs = atimeMs;
  this.mtimeMs = mtimeMs;
  this.ctimeMs = ctimeMs;
  this.birthtimeMs = birthtimeMs;
}

ObjectSetPrototypeOf(VirtualStats.prototype, VirtualStatsBase.prototype);
ObjectSetPrototypeOf(VirtualStats, VirtualStatsBase);
ObjectDefineProperties(VirtualStats.prototype, lazyDateFields);

// Factory function to create VirtualStats from simple object
function createVirtualStats(options) {
  const {
    dev = 0,
    mode = 0,
    nlink = 1,
    uid = 0,
    gid = 0,
    rdev = 0,
    blksize = 4096,
    ino = 0,
    size = 0,
    blocks = 0,
    atimeMs = Date.now(),
    mtimeMs = Date.now(),
    ctimeMs = Date.now(),
    birthtimeMs = Date.now(),
  } = options;

  return new VirtualStats(
    dev, mode, nlink, uid, gid, rdev, blksize, ino, size, blocks,
    atimeMs, mtimeMs, ctimeMs, birthtimeMs,
  );
}

module.exports = {
  VirtualStats,
  VirtualStatsBase,
  createVirtualStats,
};
