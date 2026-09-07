import { encodeAbiParameters, keccak256, parseAbi, stringToHex, zeroHash } from "viem";
import { namehash, normalize } from "viem/ens";

// Official deployment artifacts and Solidity sources are pinned to this commit.
// https://github.com/ensdomains/contracts-v2/tree/97a57293f3b4279d94b571e678edb53ce62638f4/contracts/deployments/sepolia
export const ENSV2_SUBNAME_DEPLOYMENT = {
  chainId: 11155111,
  contractsCommit: "97a57293f3b4279d94b571e678edb53ce62638f4",
  rootRegistry: "0x8115186e8f2e0b0281e86ab91f0f48ba90364354",
  ethRegistry: "0xbdc85dd5b15d7ecb354cd7cb6f2c50b4f2c4f0e2",
  factory: "0x10dc6333cdfe1fcef624c6e0a8221b91804cd7ef",
  userRegistryImplementation: "0x624a25d67b59d587752ebec8dded8827dae52050",
  resolverImplementation: "0x9eae5c2730a7dd16bdd1dee6421a1b91e3b0365e",
} as const;

export const registryAbi = parseAbi([
  "function getState(uint256 anyId) view returns ((uint8 status, uint64 expiry, address latestOwner, uint256 tokenId, uint256 resource) state)",
  "function hasRoles(uint256 anyId, uint256 roleBitmap, address account) view returns (bool)",
  "function getSubregistry(string label) view returns (address)",
  "function getResolver(string label) view returns (address)",
  "function register(string label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry) returns (uint256)",
  "function unregister(uint256 anyId)",
  "function setSubregistry(uint256 anyId, address registry)",
]);

export const factoryAbi = parseAbi([
  "function deployProxy(address implementation, uint256 salt, bytes data) returns (address proxy)",
  "function verifyContract(address proxy) view returns (address implementation)",
]);

export const registryInitAbi = parseAbi([
  "function initialize(address rootAccount, uint256 roleBitmap)",
]);

export const resolverPermissionAbi = parseAbi([
  "function hasRoles(uint256 resource, uint256 roleBitmap, address account) view returns (bool)",
  "function text(bytes32 node, string key) view returns (string)",
  "function setText(bytes32 node, string key, string value)",
]);

// RegistryRolesLib and PermissionedResolverLib use the low bit of each nybble.
export const ROLE_REGISTRAR = 1n << 0n;
export const ROLE_UNREGISTER = 1n << 12n;
export const ROLE_RENEW = 1n << 16n;
export const ROLE_SET_SUBREGISTRY = 1n << 20n;
export const ROLE_SET_RESOLVER = 1n << 24n;
export const ROLE_SET_TEXT = 1n << 4n;

// Matches ETHRegistrar.REGISTRATION_ROLE_BITMAP, including token transfer permission.
export const SUBNAME_OWNER_ROLES =
  ROLE_UNREGISTER |
  ROLE_SET_SUBREGISTRY |
  (ROLE_SET_SUBREGISTRY << 128n) |
  ROLE_SET_RESOLVER |
  (ROLE_SET_RESOLVER << 128n) |
  (1n << 156n);

// This registry can register/renew names and delegate only those root roles.
export const SUBREGISTRY_ROOT_ROLES =
  ROLE_REGISTRAR |
  ROLE_RENEW |
  (ROLE_REGISTRAR << 128n) |
  (ROLE_RENEW << 128n);

// Follows ensdomains/ens-cli src/lib/v2.ts defaultUserRegistrySalt().
export function registrySalt(parent: string): bigint {
  return BigInt(keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }],
    [keccak256(stringToHex("UserRegistry")), namehash(normalize(parent)), 0n],
  )));
}

// PermissionedResolverLib.resource(node, 0). Parent-name grants do not cover child names.
export function resolverNameResource(name: string): bigint {
  const node = namehash(normalize(name));
  if (node === zeroHash) return 0n;
  return BigInt(keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }],
    [node, zeroHash],
  )));
}
