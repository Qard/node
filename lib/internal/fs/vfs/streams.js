'use strict';

const {
  FunctionPrototypeBind,
  FunctionPrototypeCall,
  MathMin,
  ObjectDefineProperty,
  ObjectSetPrototypeOf,
  Symbol,
} = primordials;

const {
  ERR_INVALID_ARG_TYPE,
  ERR_OUT_OF_RANGE,
} = require('internal/errors').codes;
const { Readable, Writable } = require('stream');
const { Buffer } = require('buffer');

const kVFS = Symbol('kVFS');
const kFileHandle = Symbol('kFileHandle');
const kIsPerformingIO = Symbol('kIsPerformingIO');

// Construct callback for streams
function _construct(callback) {
  const stream = this;

  if (stream[kFileHandle]) {
    // Already have a file handle
    callback();
    return;
  }

  if (typeof stream.fd === 'number') {
    // Using a raw fd number
    callback();
    return;
  }

  // Need to open the file
  const vfs = stream[kVFS];
  vfs.open(stream.path, stream.flags, stream.mode, (err, fh) => {
    if (err) {
      callback(err);
    } else {
      stream[kFileHandle] = fh;
      stream.fd = fh.fd;
      callback();
      stream.emit('open', stream.fd);
      stream.emit('ready');
    }
  });
}

// Close helper for streams
function close(stream, err, cb) {
  if (!stream[kFileHandle]) {
    cb(err);
  } else if (stream.flush) {
    stream[kFileHandle].datasync((flushErr) => {
      _close(stream, err || flushErr, cb);
    });
  } else {
    _close(stream, err, cb);
  }
}

function _close(stream, err, cb) {
  stream[kFileHandle].close((er) => {
    cb(er || err);
  });
  stream[kFileHandle] = null;
  stream.fd = null;
}

/**
 * VirtualReadStream - Readable stream for VFS files
 */
function VirtualReadStream(vfs, path, options) {
  if (!(this instanceof VirtualReadStream))
    return new VirtualReadStream(vfs, path, options);

  options = options || {};

  // Default high water mark
  if (options.highWaterMark === undefined)
    options.highWaterMark = 64 * 1024;

  if (options.autoDestroy === undefined) {
    options.autoDestroy = false;
  }

  this[kVFS] = vfs;
  this[kFileHandle] = null;

  if (options.fd != null) {
    // Using an existing file handle or fd
    if (typeof options.fd === 'object' && typeof options.fd.read === 'function') {
      this[kFileHandle] = options.fd;
      this.fd = options.fd.fd;
    } else if (typeof options.fd === 'number') {
      this.fd = options.fd;
    } else {
      throw new ERR_INVALID_ARG_TYPE('options.fd', ['number', 'FileHandle'], options.fd);
    }
  } else {
    this.fd = null;
    this.path = path;
    this.flags = options.flags === undefined ? 'r' : options.flags;
    this.mode = options.mode === undefined ? 0o666 : options.mode;
  }

  options.autoDestroy = options.autoClose === undefined ?
    true : options.autoClose;

  this.start = options.start;
  this.end = options.end;
  this.pos = undefined;
  this.bytesRead = 0;
  this[kIsPerformingIO] = false;

  if (this.start !== undefined) {
    if (typeof this.start !== 'number' || this.start < 0) {
      throw new ERR_INVALID_ARG_TYPE('start', 'number', this.start);
    }
    this.pos = this.start;
  }

  if (this.end === undefined) {
    this.end = Infinity;
  } else if (this.end !== Infinity) {
    if (typeof this.end !== 'number' || this.end < 0) {
      throw new ERR_INVALID_ARG_TYPE('end', 'number', this.end);
    }

    if (this.start !== undefined && this.start > this.end) {
      throw new ERR_OUT_OF_RANGE(
        'start',
        `<= "end" (here: ${this.end})`,
        this.start,
      );
    }
  }

  FunctionPrototypeCall(Readable, this, options);
}
ObjectSetPrototypeOf(VirtualReadStream.prototype, Readable.prototype);
ObjectSetPrototypeOf(VirtualReadStream, Readable);

ObjectDefineProperty(VirtualReadStream.prototype, 'autoClose', {
  __proto__: null,
  get() {
    return this._readableState.autoDestroy;
  },
  set(val) {
    this._readableState.autoDestroy = val;
  },
});

VirtualReadStream.prototype._construct = _construct;

VirtualReadStream.prototype._read = function(n) {
  n = this.pos !== undefined ?
    MathMin(this.end - this.pos + 1, n) :
    MathMin(this.end - this.bytesRead + 1, n);

  if (n <= 0) {
    this.push(null);
    return;
  }

  this[kIsPerformingIO] = true;
  const buf = Buffer.allocUnsafeSlow(n);
  const fh = this[kFileHandle];

  fh.read(buf, 0, n, this.pos, (err, bytesRead, buffer) => {
    this[kIsPerformingIO] = false;

    if (err) {
      this.destroy(err);
      return;
    }

    if (bytesRead > 0) {
      this.bytesRead += bytesRead;

      if (this.pos !== undefined)
        this.pos += bytesRead;

      if (bytesRead !== buffer.length) {
        // Slow path. Shrink to fit.
        // Copy instead of slice so we don't retain a large buffer
        const dst = Buffer.allocUnsafeSlow(bytesRead);
        buffer.copy(dst, 0, 0, bytesRead);
        buffer = dst;
      }

      this.push(buffer);
    } else {
      this.push(null);
    }
  });
};

VirtualReadStream.prototype._destroy = function(err, cb) {
  close(this, err, cb);
};

VirtualReadStream.prototype.close = function(cb) {
  if (typeof cb === 'function') {
    this.once('close', cb);
  }
  this.destroy();
};

/**
 * VirtualWriteStream - Writable stream for VFS files
 */
function VirtualWriteStream(vfs, path, options) {
  if (!(this instanceof VirtualWriteStream))
    return new VirtualWriteStream(vfs, path, options);

  options = options || {};

  // Default high water mark
  if (options.highWaterMark === undefined)
    options.highWaterMark = 64 * 1024;

  if (options.autoDestroy === undefined) {
    options.autoDestroy = false;
  }

  this[kVFS] = vfs;
  this[kFileHandle] = null;

  if (options.fd != null) {
    // Using an existing file handle or fd
    if (typeof options.fd === 'object' && typeof options.fd.write === 'function') {
      this[kFileHandle] = options.fd;
      this.fd = options.fd.fd;
    } else if (typeof options.fd === 'number') {
      this.fd = options.fd;
    } else {
      throw new ERR_INVALID_ARG_TYPE('options.fd', ['number', 'FileHandle'], options.fd);
    }
  } else {
    this.fd = null;
    this.path = path;
    this.flags = options.flags === undefined ? 'w' : options.flags;
    this.mode = options.mode === undefined ? 0o666 : options.mode;
  }

  options.autoDestroy = options.autoClose === undefined ?
    true : options.autoClose;

  this.start = options.start;
  this.pos = undefined;
  this.bytesWritten = 0;
  this[kIsPerformingIO] = false;
  this.flush = options.flush !== false;

  if (this.start !== undefined) {
    if (typeof this.start !== 'number' || this.start < 0) {
      throw new ERR_INVALID_ARG_TYPE('start', 'number', this.start);
    }
    this.pos = this.start;
  }

  FunctionPrototypeCall(Writable, this, options);
}
ObjectSetPrototypeOf(VirtualWriteStream.prototype, Writable.prototype);
ObjectSetPrototypeOf(VirtualWriteStream, Writable);

ObjectDefineProperty(VirtualWriteStream.prototype, 'autoClose', {
  __proto__: null,
  get() {
    return this._writableState.autoDestroy;
  },
  set(val) {
    this._writableState.autoDestroy = val;
  },
});

VirtualWriteStream.prototype._construct = _construct;

VirtualWriteStream.prototype._write = function(data, encoding, cb) {
  this[kIsPerformingIO] = true;
  const fh = this[kFileHandle];

  fh.write(data, 0, data.length, this.pos, (err, bytesWritten) => {
    this[kIsPerformingIO] = false;

    if (err) {
      cb(err);
      return;
    }

    this.bytesWritten += bytesWritten;
    if (this.pos !== undefined)
      this.pos += bytesWritten;

    cb();
  });
};

VirtualWriteStream.prototype._writev = function(data, cb) {
  const len = data.length;
  const chunks = new Array(len);
  let size = 0;

  for (let i = 0; i < len; i++) {
    const chunk = data[i].chunk;
    chunks[i] = chunk;
    size += chunk.length;
  }

  const buf = Buffer.concat(chunks, size);
  this[kIsPerformingIO] = true;
  const fh = this[kFileHandle];

  fh.write(buf, 0, buf.length, this.pos, (err, bytesWritten) => {
    this[kIsPerformingIO] = false;

    if (err) {
      cb(err);
      return;
    }

    this.bytesWritten += bytesWritten;
    if (this.pos !== undefined)
      this.pos += bytesWritten;

    cb();
  });
};

VirtualWriteStream.prototype._destroy = function(err, cb) {
  close(this, err, cb);
};

VirtualWriteStream.prototype._final = function(cb) {
  if (!this.flush) {
    cb();
    return;
  }

  const fh = this[kFileHandle];
  fh.datasync((err) => cb(err));
};

VirtualWriteStream.prototype.close = function(cb) {
  if (typeof cb === 'function') {
    this.once('close', cb);
  }
  this.end();
};

module.exports = {
  VirtualReadStream,
  VirtualWriteStream,
};
