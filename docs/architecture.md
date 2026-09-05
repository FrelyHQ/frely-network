# Architecture

The P0 execution path is:

```text
Host Agent
  -> Broker MCP
  -> The Graph discovery
  -> ENS and ERC-8004 verification
  -> Provider x402 Gateway
  -> Hedera payment
  -> Provider execution
  -> result
```

The identity/discovery and payment networks are coordinated off-chain by the
Broker. The project does not require a token bridge or an Agent Runtime as a
core dependency.

Detailed interfaces and failure behavior will be added as each P0 contract is
implemented.
