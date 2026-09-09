# x402 payment boundary

This entry point exercises the payment adapter without Provider discovery.
Offline validates synthetic quotes; preflight checks approved captures and
read-only network state; live runs the journaled payment session; recover reads
the original transaction and cached outcome. The local HTTPS mock replaces
business output while retaining real facilitator verification and settlement.

Inputs, policy and output contracts are in the [x402 architecture](../../docs/architecture.md).
Stages, completion signals, retry limits and recovery rules are maintained only
in the [payment workflow](../../workflows/hedera-auto-payment.md).

## Local agent key files

Use an operator-prepared ECDSA key file outside the repository and synced folders.
Set `signerRef` to `file:<absolute path>` and `keyType` to `ecdsa` in the approved
policy. The parent directory must be owned by the current user with mode 0700;
the file must be a regular, non-symlink file owned by that user with mode 0600.
Store exactly 64 hexadecimal characters, optionally followed by one LF newline.
Do not paste a private key into CLI arguments, configuration, logs or chat.

Configuration loading and preflight do not open the key file. Signing loads the
key and checks its public key against the configured payer account through the
trusted Mirror endpoint. A failed file source never falls back to environment.
Recover uses the existing journal and does not need the key file.

File signing reports `SIGNER_UNAVAILABLE` for file access, permission or format
errors; `SIGNER_MISMATCH` when a valid account does not bind to the local ECDSA
key; and `NETWORK_CHECK_FAILED` when the Mirror query or response cannot establish
the binding.

To stop new payments, stop the running payment process and set `enabled=false`
before restarting. Configuration edits are not hot-reloaded. Deleting the key
file does not cancel signed transactions or invalidate copies of the key. See
[the local Agent key design](../../docs/superpowers/specs/2026-09-08-hedera-local-key-design.md)
for the complete boundary.

For wallets created by the SDK flow, follow the [Agent wallet CLI handoff](../../apps/agent-cli/README.md).
Merge only the returned `paymentIdentity` fields into an existing approved Policy;
preserve its business fields, registry entry, and journal path, and keep the first
handoff `enabled=false` until the operator explicitly enables payment.
