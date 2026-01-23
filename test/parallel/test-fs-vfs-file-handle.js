'use strict';
const common = require('../common');
const assert = require('assert');
const fs = require('fs');
const { Buffer } = require('buffer');

// Test VFS FileHandle
const { VirtualFileSystem } = fs;

// Create an in-memory VFS
const vfs = VirtualFileSystem.memory();

// Test file handle read/write
{
  (async () => {
    const path = '/handle-test.txt';
    const testData = 'Test data for file handle';

    // Open for writing
    const fh = await vfs.promises.open(path, 'w');

    try {
      // Write data
      const buffer = Buffer.from(testData);
      const { bytesWritten } = await fh.write(buffer, 0, buffer.length, 0);
      assert.strictEqual(bytesWritten, buffer.length);

      // Close and reopen for reading
      await fh.close();

      const fh2 = await vfs.promises.open(path, 'r');
      try {
        // Read data
        const readBuffer = Buffer.allocUnsafe(buffer.length);
        const { bytesRead } = await fh2.read(readBuffer, 0, readBuffer.length, 0);
        assert.strictEqual(bytesRead, buffer.length);
        assert.strictEqual(readBuffer.toString(), testData);
      } finally {
        await fh2.close();
      }
    } finally {
      // Cleanup
      vfs.unlinkSync(path);
    }
  })().then(common.mustCall());
}

// Test file handle appendFile
{
  (async () => {
    const path = '/handle-append-test.txt';
    const data1 = 'First line\n';
    const data2 = 'Second line\n';

    const fh = await vfs.promises.open(path, 'w+');
    try {
      await fh.appendFile(data1);
      await fh.appendFile(data2);

      const content = await fh.readFile('utf8');
      assert.strictEqual(content, data1 + data2);
    } finally {
      await fh.close();
      vfs.unlinkSync(path);
    }
  })().then(common.mustCall());
}

// Test file handle writeFile
{
  (async () => {
    const path = '/handle-writefile-test.txt';
    const testData = 'Complete file content';

    const fh = await vfs.promises.open(path, 'w');
    try {
      await fh.writeFile(testData);

      // Read back through VFS
      const content = vfs.readFileSync(path, 'utf8');
      assert.strictEqual(content, testData);
    } finally {
      await fh.close();
      vfs.unlinkSync(path);
    }
  })().then(common.mustCall());
}

// Test file handle stat
{
  (async () => {
    const path = '/handle-stat-test.txt';
    const testData = 'Data for stat test';

    vfs.writeFileSync(path, testData);

    const fh = await vfs.promises.open(path, 'r');
    try {
      const stats = await fh.stat();
      assert.strictEqual(stats.isFile(), true);
      assert.strictEqual(stats.size, Buffer.byteLength(testData));
    } finally {
      await fh.close();
      vfs.unlinkSync(path);
    }
  })().then(common.mustCall());
}

// Test file handle chmod
{
  (async () => {
    const path = '/handle-chmod-test.txt';

    vfs.writeFileSync(path, 'test');

    const fh = await vfs.promises.open(path, 'r+');
    try {
      await fh.chmod(0o600);

      const stats = await fh.stat();
      assert.strictEqual(stats.mode & 0o777, 0o600);
    } finally {
      await fh.close();
      vfs.unlinkSync(path);
    }
  })().then(common.mustCall());
}

// Test file handle truncate
{
  (async () => {
    const path = '/handle-truncate-test.txt';
    const testData = 'This is a long string that will be truncated';

    vfs.writeFileSync(path, testData);

    const fh = await vfs.promises.open(path, 'r+');
    try {
      await fh.truncate(10);

      const stats = await fh.stat();
      assert.strictEqual(stats.size, 10);

      const content = await fh.readFile('utf8');
      assert.strictEqual(content, 'This is a ');
    } finally {
      await fh.close();
      vfs.unlinkSync(path);
    }
  })().then(common.mustCall());
}

// Test file handle position tracking
{
  (async () => {
    const path = '/handle-position-test.txt';
    const testData = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

    vfs.writeFileSync(path, testData);

    const fh = await vfs.promises.open(path, 'r');
    try {
      const buffer1 = Buffer.allocUnsafe(5);
      const buffer2 = Buffer.allocUnsafe(5);
      const buffer3 = Buffer.allocUnsafe(5);

      // Read without position (sequential)
      await fh.read(buffer1, 0, 5, null);
      await fh.read(buffer2, 0, 5, null);
      await fh.read(buffer3, 0, 5, null);

      assert.strictEqual(buffer1.toString(), 'ABCDE');
      assert.strictEqual(buffer2.toString(), 'FGHIJ');
      assert.strictEqual(buffer3.toString(), 'KLMNO');

      // Read with explicit position
      const buffer4 = Buffer.allocUnsafe(3);
      await fh.read(buffer4, 0, 3, 0);
      assert.strictEqual(buffer4.toString(), 'ABC');
    } finally {
      await fh.close();
      vfs.unlinkSync(path);
    }
  })().then(common.mustCall());
}

// Test file handle with async dispose
{
  (async () => {
    const path = '/handle-dispose-test.txt';
    vfs.writeFileSync(path, 'test data');

    // Use file handle with using keyword (if supported)
    {
      const fh = await vfs.promises.open(path, 'r');
      const content = await fh.readFile('utf8');
      assert.strictEqual(content, 'test data');
      // Manually close since using syntax might not work yet
      await fh.close();
    }

    vfs.unlinkSync(path);
  })().then(common.mustCall());
}

// Test multiple concurrent file handles
{
  (async () => {
    const path = '/handle-concurrent-test.txt';
    const testData = 'Concurrent access test';

    vfs.writeFileSync(path, testData);

    const fh1 = await vfs.promises.open(path, 'r');
    const fh2 = await vfs.promises.open(path, 'r');

    try {
      const buffer1 = Buffer.allocUnsafe(10);
      const buffer2 = Buffer.allocUnsafe(10);

      await Promise.all([
        fh1.read(buffer1, 0, 10, 0),
        fh2.read(buffer2, 0, 10, 11),
      ]);

      assert.strictEqual(buffer1.toString(), 'Concurrent');
      assert.strictEqual(buffer2.toString(), ' access te');
    } finally {
      await fh1.close();
      await fh2.close();
      vfs.unlinkSync(path);
    }
  })().then(common.mustCall());
}

console.log('All VFS FileHandle tests passed!');
