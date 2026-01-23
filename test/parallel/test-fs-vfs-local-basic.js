'use strict';
const common = require('../common');
const assert = require('assert');
const fs = require('fs');
const tmpdir = require('../common/tmpdir');

tmpdir.refresh();

// Test VFS with LocalProvider
const { VirtualFileSystem } = fs;

// Create a local filesystem VFS
const vfs = VirtualFileSystem.local({ cwd: tmpdir.path });

// Test basic file operations
{
  const testFile = tmpdir.resolve('vfs-local-test.txt');
  const testData = 'Hello, Local VFS!';

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
  const testDir = tmpdir.resolve('vfs-local-testdir');

  // Create directory
  vfs.mkdirSync(testDir);
  assert.strictEqual(vfs.existsSync(testDir), true);

  const stats = vfs.statSync(testDir);
  assert.strictEqual(stats.isDirectory(), true);

  // Create file in directory
  const testFile = tmpdir.resolve('vfs-local-testdir', 'file.txt');
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
  const deepPath = tmpdir.resolve('vfs-a', 'b', 'c', 'd');
  vfs.mkdirSync(deepPath, { recursive: true });
  assert.strictEqual(vfs.existsSync(deepPath), true);

  const stats = vfs.statSync(deepPath);
  assert.strictEqual(stats.isDirectory(), true);
}

// Test rename
{
  const oldPath = tmpdir.resolve('vfs-old.txt');
  const newPath = tmpdir.resolve('vfs-new.txt');

  vfs.writeFileSync(oldPath, 'data');
  vfs.renameSync(oldPath, newPath);

  assert.strictEqual(vfs.existsSync(oldPath), false);
  assert.strictEqual(vfs.existsSync(newPath), true);

  const data = vfs.readFileSync(newPath, 'utf8');
  assert.strictEqual(data, 'data');

  vfs.unlinkSync(newPath);
}

// Test copyFile
{
  const sourcePath = tmpdir.resolve('vfs-source.txt');
  const destPath = tmpdir.resolve('vfs-dest.txt');

  vfs.writeFileSync(sourcePath, 'copy me');
  vfs.copyFileSync(sourcePath, destPath);

  const sourceData = vfs.readFileSync(sourcePath, 'utf8');
  const destData = vfs.readFileSync(destPath, 'utf8');
  assert.strictEqual(sourceData, destData);

  vfs.unlinkSync(sourcePath);
  vfs.unlinkSync(destPath);
}

// Test chmod (skip on Windows where it doesn't work the same)
if (!common.isWindows) {
  const testFile = tmpdir.resolve('vfs-perms.txt');
  vfs.writeFileSync(testFile, 'test');
  vfs.chmodSync(testFile, 0o600);

  const stats = vfs.statSync(testFile);
  assert.strictEqual(stats.mode & 0o777, 0o600);

  vfs.unlinkSync(testFile);
}

// Test symlinks (skip on Windows without privileges)
if (!common.isWindows || common.canCreateSymLink()) {
  const targetPath = tmpdir.resolve('vfs-target.txt');
  const linkPath = tmpdir.resolve('vfs-link.txt');

  vfs.writeFileSync(targetPath, 'target data');
  vfs.symlinkSync(targetPath, linkPath);

  // Read through symlink
  const data = vfs.readFileSync(linkPath, 'utf8');
  assert.strictEqual(data, 'target data');

  // lstat should show symlink
  const linkStats = vfs.lstatSync(linkPath);
  assert.strictEqual(linkStats.isSymbolicLink(), true);

  // stat should follow symlink
  const targetStats = vfs.statSync(linkPath);
  assert.strictEqual(targetStats.isFile(), true);

  // readlink should return target
  const target = vfs.readlinkSync(linkPath);
  assert.strictEqual(target, targetPath);

  vfs.unlinkSync(linkPath);
  vfs.unlinkSync(targetPath);
}

// Test hard links
{
  const targetPath = tmpdir.resolve('vfs-hardlink-target.txt');
  const linkPath = tmpdir.resolve('vfs-hardlink.txt');

  vfs.writeFileSync(targetPath, 'shared data');
  vfs.linkSync(targetPath, linkPath);

  // Both should have same content
  const data1 = vfs.readFileSync(targetPath, 'utf8');
  const data2 = vfs.readFileSync(linkPath, 'utf8');
  assert.strictEqual(data1, data2);

  // Both should have link count of 2
  const stats1 = vfs.statSync(targetPath);
  const stats2 = vfs.statSync(linkPath);
  assert.strictEqual(stats1.nlink, 2);
  assert.strictEqual(stats2.nlink, 2);

  // Both should have same inode
  assert.strictEqual(stats1.ino, stats2.ino);

  // Deleting one should not delete the other
  vfs.unlinkSync(linkPath);
  assert.strictEqual(vfs.existsSync(targetPath), true);
  assert.strictEqual(vfs.existsSync(linkPath), false);

  // Link count should be back to 1
  const stats3 = vfs.statSync(targetPath);
  assert.strictEqual(stats3.nlink, 1);

  vfs.unlinkSync(targetPath);
}

// Test promises API
{
  (async () => {
    const testFile = tmpdir.resolve('vfs-async-test.txt');
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
  const testFile = tmpdir.resolve('vfs-callback-test.txt');
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

console.log('All VFS LocalProvider tests passed!');
