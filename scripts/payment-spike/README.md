# x402 payment boundary

This entry point exercises the payment adapter without Provider discovery.
Offline validates synthetic quotes; preflight checks approved captures and
read-only network state; live runs the journaled payment session; recover reads
the original transaction and cached outcome. The local HTTPS mock replaces
business output while retaining real facilitator verification and settlement.

Inputs, policy and output contracts are in the [x402 architecture](../../docs/architecture.md).
Stages, completion signals, retry limits and recovery rules are maintained only
in the [payment workflow](../../workflows/hedera-auto-payment.md).
