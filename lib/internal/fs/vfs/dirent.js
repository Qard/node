'use strict';

const {
  UV_DIRENT_UNKNOWN,
  UV_DIRENT_FILE,
  UV_DIRENT_DIR,
  UV_DIRENT_LINK,
  UV_DIRENT_FIFO,
  UV_DIRENT_SOCKET,
  UV_DIRENT_CHAR,
  UV_DIRENT_BLOCK,
} = internalBinding('constants').fs;

const kType = Symbol('type');
const kStats = Symbol('stats');

// VirtualDirent class compatible with fs.Dirent
class VirtualDirent {
  constructor(name, type, parentPath) {
    this.name = name;
    this.parentPath = parentPath || '';
    this[kType] = type;
  }

  get path() {
    return this.parentPath;
  }

  isDirectory() {
    return this[kType] === UV_DIRENT_DIR;
  }

  isFile() {
    return this[kType] === UV_DIRENT_FILE;
  }

  isBlockDevice() {
    return this[kType] === UV_DIRENT_BLOCK;
  }

  isCharacterDevice() {
    return this[kType] === UV_DIRENT_CHAR;
  }

  isSymbolicLink() {
    return this[kType] === UV_DIRENT_LINK;
  }

  isFIFO() {
    return this[kType] === UV_DIRENT_FIFO;
  }

  isSocket() {
    return this[kType] === UV_DIRENT_SOCKET;
  }
}

// VirtualDirent created from stats
class VirtualDirentFromStats extends VirtualDirent {
  constructor(name, stats, parentPath) {
    super(name, null, parentPath);
    this[kStats] = stats;
  }

  isDirectory() {
    return this[kStats].isDirectory();
  }

  isFile() {
    return this[kStats].isFile();
  }

  isBlockDevice() {
    return this[kStats].isBlockDevice();
  }

  isCharacterDevice() {
    return this[kStats].isCharacterDevice();
  }

  isSymbolicLink() {
    return this[kStats].isSymbolicLink();
  }

  isFIFO() {
    return this[kStats].isFIFO();
  }

  isSocket() {
    return this[kStats].isSocket();
  }
}

// Factory function to create VirtualDirent from stats
function createVirtualDirent(name, stats, parentPath) {
  if (stats.isDirectory()) {
    return new VirtualDirent(name, UV_DIRENT_DIR, parentPath);
  } else if (stats.isFile()) {
    return new VirtualDirent(name, UV_DIRENT_FILE, parentPath);
  } else if (stats.isSymbolicLink()) {
    return new VirtualDirent(name, UV_DIRENT_LINK, parentPath);
  } else if (stats.isBlockDevice()) {
    return new VirtualDirent(name, UV_DIRENT_BLOCK, parentPath);
  } else if (stats.isCharacterDevice()) {
    return new VirtualDirent(name, UV_DIRENT_CHAR, parentPath);
  } else if (stats.isFIFO()) {
    return new VirtualDirent(name, UV_DIRENT_FIFO, parentPath);
  } else if (stats.isSocket()) {
    return new VirtualDirent(name, UV_DIRENT_SOCKET, parentPath);
  }
  return new VirtualDirent(name, UV_DIRENT_UNKNOWN, parentPath);
}

module.exports = {
  VirtualDirent,
  VirtualDirentFromStats,
  createVirtualDirent,
  constants: {
    UV_DIRENT_UNKNOWN,
    UV_DIRENT_FILE,
    UV_DIRENT_DIR,
    UV_DIRENT_LINK,
    UV_DIRENT_FIFO,
    UV_DIRENT_SOCKET,
    UV_DIRENT_CHAR,
    UV_DIRENT_BLOCK,
  },
};
