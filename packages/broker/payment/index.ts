import type { PaymentClientResult, PaymentRequest } from "@frely-network/hedera-x402";

export interface BrokerPaymentPort {
  request(request: PaymentRequest): Promise<PaymentClientResult>;
}

export { HederaX402Client, PaymentError } from "@frely-network/hedera-x402";
export type {
  HederaPaymentSigner,
  HederaX402ClientConfig,
  PaymentPayload,
  PaymentRequired,
  PaymentRequirement,
} from "@frely-network/hedera-x402";
