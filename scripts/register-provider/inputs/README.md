# Provider registration inputs

## web3-safety

`web3-safety.json` defines the ETHOnline demo Provider. `web3-safety.frely.eth` is an ENSv2 name on Ethereum Sepolia. It is a testnet identity, not an Ethereum Mainnet ENS asset, and the project does not claim a mainnet ENS purchase.

- ENSv2 Sepolia test name: `web3-safety.frely.eth`
- capabilities: `web3.address-risk`, `web3.url-risk`
- protocol: A2A
- execution endpoint: `https://api.frely.cloud/a2a`
- payment network: `hedera:testnet`
- `active: true`
- `x402Support: false` — Frely stays a normal Web2 Provider; Network owns x402 payment

Validate the ERC-8004 metadata:

```bash
bun run provider:identity metadata \
  --input scripts/register-provider/inputs/web3-safety.json
```

Inspect the ENSv2 subname state:

```bash
bun run ens:subnames inspect \
  --rpc-url "$ENS_SEPOLIA_RPC_URL" \
  --parent frely.eth \
  --operator "$ENS_OPERATOR_ADDRESS" \
  --labels web3-safety
```

Prepare the unsigned ENSv2 subname transaction:

```bash
bun run ens:subnames prepare-subname \
  --rpc-url "$ENS_SEPOLIA_RPC_URL" \
  --parent frely.eth \
  --operator "$ENS_OPERATOR_ADDRESS" \
  --label web3-safety
```

After wallet confirmation, rerun `inspect` before the next transaction.

Prepare the unsigned ERC-8004 registration transaction:

```bash
bun run provider:identity prepare-register \
  --input scripts/register-provider/inputs/web3-safety.json
```

After the ERC-8004 transaction is confirmed, use its transaction hash to prepare ENS endpoint and ENSIP-25 binding records:

```bash
bun run provider:identity prepare-ens \
  --input scripts/register-provider/inputs/web3-safety.json \
  --registration-tx <CONFIRMED_ERC8004_TX_HASH>
```

Each command produces unsigned or read-only output. Signing and broadcasting stay in the operator wallet.
