'use strict';
const common = require('../common');
const assert = require('assert');
const fs = require('fs');

// Test VFS with MemoryProvider
const { VirtualFileSystem } = fs;

// Create an in-memory VFS
const vfs = VirtualFileSystem.memory();

// Test basic file operations
{
  const testFile = '/test.txt';
  const testData = 'Hello, VFS!';

  // Write file
  vfs.writeFileSync(testFile, testData);

  // Read file
  const data = vfs.readFileSync(testFile, 'utf8');
  assert.strictEqual(data, testData);

  // Check file exists
  assert.strictEqual(vfs.existsSync(testFile), true);

  // Get stats
  const stats = vfs.statSync(testFile);
  assert.strictEqual(stats.isFile(), true);
  assert.strictEqual(stats.size, Buffer.byteLength(testData));

  // Append to file
  vfs.appendFileSync(testFile, ' More data');
  const appendedData = vfs.readFileSync(testFile, 'utf8');
  assert.strictEqual(appendedData, testData + ' More data');

  // Delete file
  vfs.unlinkSync(testFile);
  assert.strictEqual(vfs.existsSync(testFile), false);
}

// Test directory operations
{
  const testDir = '/testdir';

  // Create directory
  vfs.mkdirSync(testDir);
  assert.strictEqual(vfs.existsSync(testDir), true);

  const stats = vfs.statSync(testDir);
  assert.strictEqual(stats.isDirectory(), true);

  // Create file in directory
  const testFile = '/testdir/file.txt';
  vfs.writeFileSync(testFile, 'test');

  // Read directory
  const entries = vfs.readdirSync(testDir);
  assert.strictEqual(entries.includes('file.txt'), true);

  // Delete file
  vfs.unlinkSync(testFile);

  // Delete directory
  vfs.rmdirSync(testDir);
  assert.strictEqual(vfs.existsSync(testDir), false);
}

// Test recursive mkdir
{
  const deepPath = '/a/b/c/d';
  vfs.mkdirSync(deepPath, { recursive: true });
  assert.strictEqual(vfs.existsSync(deepPath), true);

  const stats = vfs.statSync(deepPath);
  assert.strictEqual(stats.isDirectory(), true);
}

// Test rename
{
  vfs.writeFileSync('/old.txt', 'data');
  vfs.renameSync('/old.txt', '/new.txt');

  assert.strictEqual(vfs.existsSync('/old.txt'), false);
  assert.strictEqual(vfs.existsSync('/new.txt'), true);

  const data = vfs.readFileSync('/new.txt', 'utf8');
  assert.strictEqual(data, 'data');
}

// Test copyFile
{
  vfs.writeFileSync('/source.txt', 'copy me');
  vfs.copyFileSync('/source.txt', '/dest.txt');

  const sourceData = vfs.readFileSync('/source.txt', 'utf8');
  const destData = vfs.readFileSync('/dest.txt', 'utf8');
  assert.strictEqual(sourceData, destData);
}

// Test chmod
{
  vfs.writeFileSync('/perms.txt', 'test');
  vfs.chmodSync('/perms.txt', 0o600);

  const stats = vfs.statSync('/perms.txt');
  assert.strictEqual(stats.mode & 0o777, 0o600);
}

// Test symlinks
{
  vfs.writeFileSync('/target.txt', 'target data');
  vfs.symlinkSync('/target.txt', '/link.txt');

  // Read through symlink
  const data = vfs.readFileSync('/link.txt', 'utf8');
  assert.strictEqual(data, 'target data');

  // lstat should show symlink
  const linkStats = vfs.lstatSync('/link.txt');
  assert.strictEqual(linkStats.isSymbolicLink(), true);

  // stat should follow symlink
  const targetStats = vfs.statSync('/link.txt');
  assert.strictEqual(targetStats.isFile(), true);

  // readlink should return target
  const target = vfs.readlinkSync('/link.txt');
  assert.strictEqual(target, '/target.txt');
}

// Test hard links
{
  vfs.writeFileSync('/hardlink-target.txt', 'shared data');
  vfs.linkSync('/hardlink-target.txt', '/hardlink.txt');

  // Both should have same content
  const data1 = vfs.readFileSync('/hardlink-target.txt', 'utf8');
  const data2 = vfs.readFileSync('/hardlink.txt', 'utf8');
  assert.strictEqual(data1, data2);

  // Both should have link count of 2
  const stats1 = vfs.statSync('/hardlink-target.txt');
  const stats2 = vfs.statSync('/hardlink.txt');
  assert.strictEqual(stats1.nlink, 2);
  assert.strictEqual(stats2.nlink, 2);

  // Both should have same inode
  assert.strictEqual(stats1.ino, stats2.ino);

  // Deleting one should not delete the other
  vfs.unlinkSync('/hardlink.txt');
  assert.strictEqual(vfs.existsSync('/hardlink-target.txt'), true);
  assert.strictEqual(vfs.existsSync('/hardlink.txt'), false);

  // Link count should be back to 1
  const stats3 = vfs.statSync('/hardlink-target.txt');
  assert.strictEqual(stats3.nlink, 1);
}

// Test promises API
{
  (async () => {
    const testFile = '/async-test.txt';
    const testData = 'Async data';

    await vfs.promises.writeFile(testFile, testData);
    const data = await vfs.promises.readFile(testFile, 'utf8');
    assert.strictEqual(data, testData);

    const stats = await vfs.promises.stat(testFile);
    assert.strictEqual(stats.isFile(), true);

    await vfs.promises.unlink(testFile);
    assert.strictEqual(vfs.existsSync(testFile), false);
  })().then(common.mustCall());
}

// Test callback API
{
  const testFile = '/callback-test.txt';
  const testData = 'Callback data';

  vfs.writeFile(testFile, testData, common.mustCall((err) => {
    assert.ifError(err);

    vfs.readFile(testFile, 'utf8', common.mustCall((err, data) => {
      assert.ifError(err);
      assert.strictEqual(data, testData);

      vfs.unlink(testFile, common.mustCall((err) => {
        assert.ifError(err);
      }));
    }));
  }));
}

// Test readdir with withFileTypes
{
  vfs.mkdirSync('/dirtest', { recursive: true });
  vfs.writeFileSync('/dirtest/file1.txt', 'data1');
  vfs.writeFileSync('/dirtest/file2.txt', 'data2');
  vfs.mkdirSync('/dirtest/subdir');
  vfs.symlinkSync('/dirtest/file1.txt', '/dirtest/link.txt');

  const entries = vfs.readdirSync('/dirtest', { withFileTypes: true });

  assert.strictEqual(entries.length, 4);

  const file1 = entries.find((e) => e.name === 'file1.txt');
  assert.strictEqual(file1.isFile(), true);

  const subdir = entries.find((e) => e.name === 'subdir');
  assert.strictEqual(subdir.isDirectory(), true);

  const link = entries.find((e) => e.name === 'link.txt');
  assert.strictEqual(link.isSymbolicLink(), true);
}

console.log('All VFS MemoryProvider tests passed!');
