import 'dotenv/config';
import WebSocket from 'ws';
import {
  Account,
  Aptos,
  Ed25519PrivateKey,
} from '@aptos-labs/ts-sdk';
import {
  MerkleClient,
  MerkleClientConfig,
} from '@merkletrade/ts-sdk';

const FAUCET_AMOUNT = 10_000_000n; // 10 USDC in base units (6 decimals)
const INDEXER_RETRIES = 10;
const INDEXER_RETRY_MS = 1_000;

function ensureWebSocketGlobal() {
  const globalRef = globalThis as { WebSocket?: typeof WebSocket };
  if (!globalRef.WebSocket) {
    globalRef.WebSocket = WebSocket as unknown as typeof WebSocket;
  }
}

async function bootstrapClients() {
  ensureWebSocketGlobal();

  const privateKeyHex = process.env.PRIVATE_KEY?.trim();
  if (!privateKeyHex) {
    throw new Error('Set PRIVATE_KEY in your environment (copy .env.example)');
  }

  const privateKey = new Ed25519PrivateKey(privateKeyHex);
  const account = Account.fromPrivateKey({ privateKey });

  const merkle = new MerkleClient(await MerkleClientConfig.testnet());
  const aptos = new Aptos(merkle.config.aptosConfig);

  return { merkle, aptos, account };
}

function formatUsdc(amount: bigint) {
  return (Number(amount) / 1_000_000).toFixed(6);
}

async function fetchUsdcBalance(merkle: MerkleClient, account: Account) {
  return merkle.getUsdcBalance({ accountAddress: account.accountAddress });
}

async function waitForUpdatedBalance(
  merkle: MerkleClient,
  account: Account,
  previousBalance: bigint,
) {
  let attempts = INDEXER_RETRIES;
  while (attempts > 0) {
    const balance = await fetchUsdcBalance(merkle, account);
    if (balance > previousBalance) {
      return balance;
    }
    attempts -= 1;
    if (attempts === 0) return balance;
    await new Promise((resolve) => setTimeout(resolve, INDEXER_RETRY_MS));
  }
  return previousBalance;
}

async function main() {
  const { merkle, aptos, account } = await bootstrapClients();

  console.log('Account address:', account.accountAddress.toString());

  const beforeBalance = await fetchUsdcBalance(merkle, account);
  console.log('Balance before faucet:', `${formatUsdc(beforeBalance)} USDC`);

  console.log('Requesting Merkle testnet USDC faucet...');
  const payload = await merkle.payloads.testnetFaucetUSDC({ amount: FAUCET_AMOUNT });

  const rawTxn = await aptos.transaction.build.simple({
    sender: account.accountAddress,
    data: payload,
  });

  const pending = await aptos.signAndSubmitTransaction({
    signer: account,
    transaction: rawTxn,
  });
  console.log('Pending faucet transaction hash:', pending.hash);

  const committed = await aptos.waitForTransaction({ transactionHash: pending.hash });
  console.log('Faucet confirmed at version:', committed.version);

  const afterBalance = await waitForUpdatedBalance(merkle, account, beforeBalance);
  console.log('Balance after faucet:', `${formatUsdc(afterBalance)} USDC`);

  if (afterBalance === beforeBalance) {
    console.warn(
      'Indexer may still be catching up. Re-run `npm run faucet` or `npm run start` in a few seconds to see the updated balance.',
    );
  }
}

main().catch((error) => {
  console.error('Faucet error:', error);
  process.exitCode = 1;
});
