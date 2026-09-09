import { chmod, mkdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { fileKeyPath, readAgentKey } from './key-file.ts';
import { withTestKey } from './key-file.test-support.ts';

test('loads a real ECDSA key and reads it again after the file changes', async () => {
  await withTestKey(async file => {
    const message = new TextEncoder().encode('synthetic key storage check');
    const loaded = await readAgentKey(file.ref);
    expect(file.key.publicKey.verify(message, loaded.sign(message))).toBe(true);

    await unlink(file.path);
    await expect(readAgentKey(file.ref)).rejects.toThrow('SIGNER_UNAVAILABLE');
  });
});

test('accepts only literal canonical absolute file references', () => {
  expect(fileKeyPath('file:/tmp/a b%20.key')).toBe('/tmp/a b%20.key');
  for (const ref of [
    'env:KEY',
    'file:relative',
    'file:~/key',
    'file:///tmp/key',
    'file:/tmp/../key',
    'file:/',
    'file:/tmp/key\n',
  ]) {
    expect(fileKeyPath(ref)).toBeNull();
  }
});

test('rejects malformed or incorrectly permissioned key files', async () => {
  await withTestKey(async file => {
    await writeFile(file.path, `${file.key.toStringRaw()}\r\n`);
    await expect(readAgentKey(file.ref)).rejects.toThrow('SIGNER_UNAVAILABLE');

    await writeFile(file.path, 'z'.repeat(64));
    await expect(readAgentKey(file.ref)).rejects.toThrow('SIGNER_UNAVAILABLE');

    await writeFile(file.path, file.key.toStringRaw());
    await chmod(file.path, 0o644);
    await expect(readAgentKey(file.ref)).rejects.toThrow('SIGNER_UNAVAILABLE');
  });
});

test('rejects symbolic links and non-file paths', async () => {
  await withTestKey(async file => {
    const link = join(file.dir, 'link.key');
    await symlink(file.path, link);
    await expect(readAgentKey(`file:${link}`)).rejects.toThrow('SIGNER_UNAVAILABLE');

    const directory = join(file.dir, 'directory');
    await mkdir(directory, { mode: 0o700 });
    await expect(readAgentKey(`file:${directory}`)).rejects.toThrow('SIGNER_UNAVAILABLE');
  });
});
