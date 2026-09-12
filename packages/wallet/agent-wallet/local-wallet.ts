import { PrivateKey } from "@hiero-ledger/sdk";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, posix } from "node:path";
import type { AgentWalletDescriptor, HederaKeySigner } from "./types.ts";

const KEY_NAME = "agent.key";
const WALLET_NAME = "wallet.json";
const KEY_LIMIT = 128;
const JSON_LIMIT = 4096;
const ACCOUNT_ID = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

function failure(code: "WALLET_STATE_INVALID" | "INIT_CONFIG_CONFLICT" | "SIGNER_UNAVAILABLE"): Error {
  return new Error(code);
}

function currentUid(): number {
  if (typeof process.getuid !== "function") throw failure("WALLET_STATE_INVALID");
  return process.getuid();
}

function assertWalletDirectory(directory: string): string {
  if (
    !isAbsolute(directory) ||
    normalize(directory) !== directory ||
    directory === posix.parse(directory).root ||
    /[\0\r\n]/.test(directory)
  ) {
    throw failure("WALLET_STATE_INVALID");
  }
  return directory;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function parseAgentWalletDescriptor(value: unknown): AgentWalletDescriptor {
  const object = asObject(value);
  const keys = object ? Object.keys(object) : [];
  if (
    !object ||
    keys.length !== 6 ||
    object.version !== 1 ||
    object.network !== "hedera:testnet" ||
    object.keyType !== "ecdsa" ||
    typeof object.accountId !== "string" ||
    object.accountId.length === 0 ||
    typeof object.publicKey !== "string" ||
    !/^[0-9a-fA-F]{66}$/.test(object.publicKey) ||
    typeof object.privateKeyRef !== "string" ||
    !object.privateKeyRef.startsWith("file:")
  ) {
    throw failure("WALLET_STATE_INVALID");
  }
  return {
    version: 1,
    network: "hedera:testnet",
    accountId: object.accountId,
    keyType: "ecdsa",
    publicKey: object.publicKey,
    privateKeyRef: object.privateKeyRef,
  };
}

async function inspectPath(path: string, expected: "dir" | "file", mode: number, maxBytes?: number) {
  let info;
  try {
    info = await lstat(path);
  } catch {
    return { exists: false as const };
  }
  if (info.isSymbolicLink() || info.uid !== currentUid()) {
    throw failure("WALLET_STATE_INVALID");
  }
  if (expected === "dir") {
    if (!info.isDirectory() || (info.mode & 0o7777) !== mode) {
      throw failure("WALLET_STATE_INVALID");
    }
  } else if (!info.isFile() || (info.mode & 0o7777) !== mode || (maxBytes !== undefined && info.size > maxBytes)) {
    throw failure("WALLET_STATE_INVALID");
  }
  return { exists: true as const, info };
}

async function readLimited(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== currentUid() || (info.mode & 0o7777) !== 0o600 || info.size > maxBytes) {
      throw failure("WALLET_STATE_INVALID");
    }
    const buffer = Buffer.alloc(Number(info.size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function writeExclusive(path: string, content: string): Promise<void> {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== currentUid()) {
      throw failure("WALLET_STATE_INVALID");
    }
    await handle.chmod(0o600);
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    await writeExclusive(temporary, content);
    await rename(temporary, path);
    const directory = await open(dirname(path), constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function readPrivateKeyHex(path: string): Promise<string> {
  let text = "";
  try {
    text = await readLimited(path, KEY_LIMIT);
    const encoded = text.endsWith("\n") ? text.slice(0, -1) : text;
    if (encoded.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(encoded)) {
      throw failure("WALLET_STATE_INVALID");
    }
    const key = PrivateKey.fromStringECDSA(encoded);
    key.publicKey.toStringRaw();
    return encoded;
  } catch (error) {
    if (error instanceof Error && error.message === "WALLET_STATE_INVALID") throw error;
    throw failure("WALLET_STATE_INVALID");
  } finally {
    text = "";
  }
}

export async function readWalletFiles(directory: string): Promise<{
  descriptor: AgentWalletDescriptor;
  keyPath: string;
}> {
  const dir = assertWalletDirectory(directory);
  await inspectPath(dir, "dir", 0o700);
  const keyPath = join(dir, KEY_NAME);
  const walletPath = join(dir, WALLET_NAME);
  await inspectPath(keyPath, "file", 0o600, KEY_LIMIT);
  await inspectPath(walletPath, "file", 0o600, JSON_LIMIT);

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readLimited(walletPath, JSON_LIMIT));
  } catch (error) {
    if (error instanceof Error && error.message === "WALLET_STATE_INVALID") throw error;
    throw failure("WALLET_STATE_INVALID");
  }
  const descriptor = parseAgentWalletDescriptor(parsed);
  if (descriptor.privateKeyRef !== `file:${keyPath}`) {
    throw failure("WALLET_STATE_INVALID");
  }
  const hex = await readPrivateKeyHex(keyPath);
  const key = PrivateKey.fromStringECDSA(hex);
  if (key.publicKey.toStringRaw() !== descriptor.publicKey) {
    throw failure("WALLET_STATE_INVALID");
  }
  return { descriptor, keyPath };
}

export async function initLocalWallet(input: {
  directory: string;
  network: "hedera:testnet";
}): Promise<AgentWalletDescriptor> {
  if (input.network !== "hedera:testnet") throw failure("INIT_CONFIG_CONFLICT");
  const dir = assertWalletDirectory(input.directory);
  const keyPath = join(dir, KEY_NAME);
  const walletPath = join(dir, WALLET_NAME);

  const existingDir = await inspectPath(dir, "dir", 0o700).catch((error) => {
    if (error instanceof Error && error.message === "WALLET_STATE_INVALID") throw error;
    return { exists: false as const };
  });

  if (!existingDir.exists) {
    try {
      await mkdir(dir, { mode: 0o700 });
      const handle = await open(dir, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await handle.chmod(0o700);
      } finally {
        await handle.close();
      }
    } catch {
      throw failure("WALLET_STATE_INVALID");
    }
    const created = await inspectPath(dir, "dir", 0o700);
    if (!created.exists) throw failure("WALLET_STATE_INVALID");
  }

  const keyState = await inspectPath(keyPath, "file", 0o600, KEY_LIMIT).catch((error) => {
    if (error instanceof Error && error.message === "WALLET_STATE_INVALID") throw error;
    return { exists: false as const };
  });
  const walletState = await inspectPath(walletPath, "file", 0o600, JSON_LIMIT).catch((error) => {
    if (error instanceof Error && error.message === "WALLET_STATE_INVALID") throw error;
    return { exists: false as const };
  });

  if (keyState.exists && walletState.exists) {
    return (await readWalletFiles(dir)).descriptor;
  }
  if (keyState.exists || walletState.exists) {
    throw failure("WALLET_STATE_INVALID");
  }

  const generated = await PrivateKey.generateECDSAAsync();
  const publicKey = generated.publicKey.toStringRaw();
  const descriptor: AgentWalletDescriptor = {
    version: 1,
    network: "hedera:testnet",
    accountId: `0x${generated.publicKey.toEvmAddress()}`,
    keyType: "ecdsa",
    publicKey,
    privateKeyRef: `file:${keyPath}`,
  };

  try {
    await atomicWrite(keyPath, `${generated.toStringRaw()}\n`);
    await atomicWrite(walletPath, `${JSON.stringify(descriptor, null, 2)}\n`);
  } catch (error) {
    if (error instanceof Error && error.message === "WALLET_STATE_INVALID") throw error;
    throw failure("WALLET_STATE_INVALID");
  }

  return (await readWalletFiles(dir)).descriptor;
}

export async function createHederaSigner(input: {
  directory: string;
  accountId: string;
}): Promise<HederaKeySigner> {
  if (!ACCOUNT_ID.test(input.accountId)) throw failure("SIGNER_UNAVAILABLE");
  let keyPath: string;
  let descriptor: AgentWalletDescriptor;
  try {
    ({ descriptor, keyPath } = await readWalletFiles(input.directory));
  } catch {
    throw failure("SIGNER_UNAVAILABLE");
  }
  return {
    accountId: input.accountId,
    publicKey: descriptor.publicKey,
    async loadPrivateKey() {
      try {
        return await readPrivateKeyHex(keyPath);
      } catch {
        throw failure("SIGNER_UNAVAILABLE");
      }
    },
  };
}
