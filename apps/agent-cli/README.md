# Agent wallet CLI

This development command creates or resumes one local Hedera Testnet Agent wallet:

```sh
bun run agent wallet init --network hedera:testnet --max-fee-hbar <amount> --reserve-hbar <amount>
```

The default directory is `~/.frely/wallets/hedera-testnet/default`. Use
`--wallet-dir <canonical-absolute-path>` to select another local directory. Keep
wallets outside repositories and synchronized folders. Both HBAR amounts must be
positive decimal values with at most eight fractional digits. They authorize one
activation fee limit and the balance that must remain; they are not fee estimates.

An existing wallet resumes with its saved limits when both amount options are
omitted:

```sh
bun run agent wallet init --network hedera:testnet --wallet-dir <existing-wallet-directory>
```

Interactive terminals prompt for missing first-run amounts. Non-interactive runs
must provide both. `--format json` emits one JSON object per line for progress and
the final result. Human output provides the funding checkpoint from the canonical
[wallet initialization workflow](../../workflows/agent-wallet-init.md).

Exit 0 means the wallet is verified ready. Exit 2 means invalid input or a blocked
state. Exit 3 means funding, read-only verification, or recovery remains pending.
The CLI never prints the private key, edits payment policy or registry files,
enables payment, or starts the Broker.

When a ready result includes `paymentIdentity`, copy only its `network`,
`payerAccountId`, `keyType`, and `signerRef` fields into an existing approved
payment Policy. Preserve all business and safety fields, keep `enabled=false` for
the first handoff, and retain the existing registry and journal paths. The
[payment workflow](../../workflows/hedera-auto-payment.md) remains authoritative.
