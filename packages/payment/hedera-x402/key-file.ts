import { constants } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { posix } from 'node:path';
import { PrivateKey } from '@x402/hedera';

export function fileKeyPath(ref: unknown): string | null {
  if (typeof ref !== 'string' || !ref.startsWith('file:')) return null;
  const path = ref.slice(5);
  return path.startsWith('/') &&
    !path.startsWith('//') &&
    path !== '/' &&
    !path.endsWith('/') &&
    !/[\0\r\n]/.test(path) &&
    posix.normalize(path) === path
    ? path
    : null;
}

export async function readAgentKey(ref: string): Promise<PrivateKey> {
  let handle: FileHandle | undefined;
  const buffer = Buffer.alloc(1025);

  try {
    if (
      process.platform === 'win32' ||
      typeof process.getuid !== 'function' ||
      typeof constants.O_NOFOLLOW !== 'number'
    ) throw Error();

    const path = fileKeyPath(ref);
    if (!path || await realpath(path) !== path) throw Error();

    const uid = process.getuid();
    const parent = await lstat(posix.dirname(path));
    if (!parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o7777) !== 0o700) {
      throw Error();
    }

    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o7777) !== 0o600 || stat.size > 1024) {
      throw Error();
    }

    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > 1024) throw Error();

    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size));
    const encoded = text.endsWith('\n') ? text.slice(0, -1) : text;
    if (encoded.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(encoded)) throw Error();

    const key = PrivateKey.fromStringECDSA(encoded);
    key.publicKey.toStringRaw();
    return key;
  } catch {
    throw Error('SIGNER_UNAVAILABLE');
  } finally {
    buffer.fill(0);
    await handle?.close().catch(() => {});
  }
}
