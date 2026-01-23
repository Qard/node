'use strict';

const common = require('../common');
const assert = require('assert');
const { VirtualFileSystem } = require('fs');
const { pipeline } = require('stream');

// Test createReadStream
{
  const vfs = VirtualFileSystem.memory();
  const testData = 'Hello, VFS Streams!\n'.repeat(100);

  vfs.writeFileSync('/test.txt', testData);

  const rs = vfs.createReadStream('/test.txt');
  const chunks = [];

  rs.on('data', (chunk) => {
    chunks.push(chunk);
  });

  rs.on('end', common.mustCall(() => {
    const result = Buffer.concat(chunks).toString('utf8');
    assert.strictEqual(result, testData);
  }));

  rs.on('error', (err) => {
    assert.fail(`Unexpected error: ${err.message}`);
  });
}

// Test createWriteStream
{
  const vfs = VirtualFileSystem.memory();
  const testData = 'Testing write stream!\n'.repeat(50);

  const ws = vfs.createWriteStream('/output.txt');

  ws.on('finish', common.mustCall(() => {
    const result = vfs.readFileSync('/output.txt', 'utf8');
    assert.strictEqual(result, testData);
  }));

  ws.on('error', (err) => {
    assert.fail(`Unexpected error: ${err.message}`);
  });

  ws.write(testData);
  ws.end();
}

// Test stream with start and end options
{
  const vfs = VirtualFileSystem.memory();
  const testData = '0123456789'.repeat(10); // 100 bytes

  vfs.writeFileSync('/partial.txt', testData);

  const rs = vfs.createReadStream('/partial.txt', {
    start: 10,
    end: 29, // Read bytes 10-29 (20 bytes)
  });

  const chunks = [];

  rs.on('data', (chunk) => {
    chunks.push(chunk);
  });

  rs.on('end', common.mustCall(() => {
    const result = Buffer.concat(chunks).toString('utf8');
    assert.strictEqual(result.length, 20);
    assert.strictEqual(result, testData.slice(10, 30));
  }));
}

// Test piping between streams
{
  const vfs = VirtualFileSystem.memory();
  const testData = 'Piping test data!\n'.repeat(100);

  vfs.writeFileSync('/source.txt', testData);

  const rs = vfs.createReadStream('/source.txt');
  const ws = vfs.createWriteStream('/destination.txt');

  rs.pipe(ws);

  ws.on('finish', common.mustCall(() => {
    const result = vfs.readFileSync('/destination.txt', 'utf8');
    assert.strictEqual(result, testData);
  }));
}

// Test stream with FileHandle
{
  const vfs = VirtualFileSystem.memory();
  const testData = 'FileHandle stream test!';

  vfs.writeFileSync('/fh-test.txt', testData);

  vfs.promises.open('/fh-test.txt', 'r').then(common.mustCall((fh) => {
    const rs = fh.createReadStream();
    const chunks = [];

    rs.on('data', (chunk) => {
      chunks.push(chunk);
    });

    rs.on('end', common.mustCall(() => {
      const result = Buffer.concat(chunks).toString('utf8');
      assert.strictEqual(result, testData);
      fh.close().catch(() => {});
    }));
  }));
}

// Test stream write with FileHandle
{
  const vfs = VirtualFileSystem.memory();
  const testData = 'FileHandle write stream test!';

  vfs.promises.open('/fh-write.txt', 'w').then(common.mustCall((fh) => {
    const ws = fh.createWriteStream();

    ws.on('finish', common.mustCall(() => {
      fh.readFile('utf8').then(common.mustCall((result) => {
        assert.strictEqual(result, testData);
        fh.close().catch(() => {});
      }));
    }));

    ws.write(testData);
    ws.end();
  }));
}

// Test autoClose behavior
{
  const vfs = VirtualFileSystem.memory();
  vfs.writeFileSync('/autoclose.txt', 'test data');

  const rs = vfs.createReadStream('/autoclose.txt', { autoClose: true });
  const chunks = [];

  rs.on('data', (chunk) => {
    chunks.push(chunk);
  });

  rs.on('close', common.mustCall(() => {
    // Stream should auto-close after reading
  }));
}

// Test error handling - file not found
{
  const vfs = VirtualFileSystem.memory();

  const rs = vfs.createReadStream('/nonexistent.txt');

  rs.on('error', common.mustCall((err) => {
    assert.strictEqual(err.code, 'ENOENT');
  }));
}

// Test pipeline with streams
{
  const vfs = VirtualFileSystem.memory();
  const testData = 'Pipeline test!\n'.repeat(50);

  vfs.writeFileSync('/pipeline-src.txt', testData);

  const rs = vfs.createReadStream('/pipeline-src.txt');
  const ws = vfs.createWriteStream('/pipeline-dest.txt');

  pipeline(rs, ws, common.mustCall((err) => {
    assert.ifError(err);
    const result = vfs.readFileSync('/pipeline-dest.txt', 'utf8');
    assert.strictEqual(result, testData);
  }));
}

// Test large file streaming
{
  const vfs = VirtualFileSystem.memory();
  // Create a larger file (1MB)
  const chunk = 'x'.repeat(1024); // 1KB
  const testData = chunk.repeat(1024); // 1MB

  vfs.writeFileSync('/large.txt', testData);

  const rs = vfs.createReadStream('/large.txt', { highWaterMark: 16 * 1024 });
  let totalRead = 0;

  rs.on('data', (chunk) => {
    totalRead += chunk.length;
  });

  rs.on('end', common.mustCall(() => {
    assert.strictEqual(totalRead, testData.length);
  }));
}

// Test write stream with start option
{
  const vfs = VirtualFileSystem.memory();
  vfs.writeFileSync('/overwrite.txt', '0123456789');

  const ws = vfs.createWriteStream('/overwrite.txt', {
    flags: 'r+', // Open for reading and writing
    start: 5,
  });

  ws.on('finish', common.mustCall(() => {
    const result = vfs.readFileSync('/overwrite.txt', 'utf8');
    // Should have replaced bytes starting at position 5
    assert.strictEqual(result, '01234XXXXX');
  }));

  ws.write('XXXXX');
  ws.end();
}
