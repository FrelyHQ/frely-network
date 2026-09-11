import { readExistingWalletFiles } from './local-wallet.ts';
import type { Identity } from './types.ts';

export async function readReadyWalletIdentity(walletDir: string): Promise<Identity> {
  try {
    const { snapshot } = await readExistingWalletFiles(walletDir, { readSecret: false });
    const { wallet, state } = snapshot;
    if (state.phase !== 'Ready' || !wallet.accountId || !wallet.verifiedAt) {
      throw new Error('WALLET_NOT_READY');
    }
    return {
      network: 'hedera:testnet',
      payerAccountId: wallet.accountId,
      keyType: 'ecdsa',
      signerRef: wallet.signerRef,
    };
  } catch {
    throw new Error('WALLET_NOT_READY');
  }
}
