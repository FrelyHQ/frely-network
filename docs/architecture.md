# Architecture

The current P0 target is:

```text
Wallet Agent
  -> Network discovery through The Graph
  -> ENS / ERC-8004 / A2A Agent Card verification
  -> Network HTTP 402 and Wallet Agent signed PaymentPayload
  -> Blocky402 /verify (no broadcast)
  -> Frely authorization/reservation
  -> Frely A2A service
  -> Swarm execution
  -> Frely finalCharge
  -> Network calls Blocky402 /settle with the original exact amount
  -> Hedera settlement evidence and business result
```

The identity/discovery and payment networks are coordinated off-chain by the
Network. The project does not require a token bridge or an Agent Runtime as a
core dependency.

G returns the ENS-verified A2A execution URL and separate Agent Card URL. The
Network payment ingress is separate B-owned configuration. A service's native
`x402Support` declaration does not represent Network payment status, and identity
verification never authorizes unpaid execution. Under DEC-016/API-011, Network is
the Resource Server and Blocky402 is the independent Facilitator: verification
precedes resource execution, and settlement follows successful execution. The
Facilitator adds the feePayer signature and broadcasts; Network does neither.
The signed exact amount cannot be changed to finalCharge at settlement. Frely
records actual costs, with any difference handled through Network/Frely
reconciliation and compensation. B/W own implementation and live verification.

The G/B contract and review status live in the
[frely-docs interface contract](https://github.com/FrelyHQ/frely-docs/blob/main/docs/web3-ethglobal2026/frely-network/interface-contracts.md).
These targets do not claim a completed live payment or execution integration.
