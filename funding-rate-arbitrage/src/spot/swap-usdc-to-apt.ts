import 'dotenv/config';
import {
  Account,
  Aptos,
  AptosApiError,
  Ed25519PrivateKey,
  Network,
} from '@aptos-labs/ts-sdk';
import { initHyperionSDK } from '@hyperionxyz/sdk';

type Args = {
  amount?: string;
  slippageBps?: number;
  submit?: boolean;
  safeMode?: boolean;
};

const USDC_FA = '0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b';
const APT_FA = '0xa';
const USDC_DECIMALS = 6;
const APT_DECIMALS = 8;
const DEFAULT_AMOUNT = '5';

function parseArgs(argv: string[]): Args {
  const result: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    switch (key) {
      case 'amount':
        if (next && !next.startsWith('--')) {
          result.amount = next;
          i += 1;
        }
        break;
      case 'slippage-bps':
        if (next && !next.startsWith('--')) {
          result.slippageBps = Number(next);
          i += 1;
        }
        break;
      case 'safe-mode':
        if (next && !next.startsWith('--')) {
          result.safeMode = next.toLowerCase() !== 'false';
          i += 1;
        } else {
          result.safeMode = true;
        }
        break;
      case 'submit':
        if (next && !next.startsWith('--')) {
          result.submit = next.toLowerCase() === 'true';
          i += 1;
        } else {
          result.submit = true;
        }
        break;
      default:
        break;
    }
  }
  return result;
}

function toBaseUnits(amount: string, decimals: number): string {
  if (!amount.includes('.')) {
    return `${amount}${'0'.repeat(decimals)}`;
  }
  const [whole, fractionRaw = ''] = amount.split('.');
  const fraction = fractionRaw.slice(0, decimals).padEnd(decimals, '0');
  const normalized = `${whole}${fraction}`.replace(/^0+/, '') || '0';
  return normalized;
}

function formatFromBaseUnits(baseUnits: string, decimals: number): string {
  if (!baseUnits) return '0';
  const padded = baseUnits.padStart(decimals + 1, '0');
  const whole = padded.slice(0, -decimals) || '0';
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return fraction.length > 0 ? `${whole}.${fraction}` : whole;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const amountHuman = args.amount ?? DEFAULT_AMOUNT;
  const slippageBps = Number.isFinite(args.slippageBps) ? (args.slippageBps as number) : 50;
  const safeMode = args.safeMode ?? true;
  const submit = args.submit ?? false;

  const sdk = initHyperionSDK({
    network: Network.MAINNET,
    APTOS_API_KEY: process.env.APTOS_API_KEY ?? '',
  });

  const amountBase = toBaseUnits(amountHuman, USDC_DECIMALS);

  console.log('--- Hyperion Swap Quote ---');
  console.log('Network       : mainnet');
  console.log('From (USDC)   :', USDC_FA);
  console.log('To (APT)      :', APT_FA);
  console.log('Amount (USDC) :', amountHuman, `(base units: ${amountBase})`);
  console.log('Slippage (bps):', slippageBps);

  const quote = await sdk.Swap.estToAmount({
    from: USDC_FA,
    to: APT_FA,
    amount: amountBase,
    safeMode,
  });

  const bestRoute = (quote as any)?.bestRoute ?? quote;
  if (!bestRoute?.path || bestRoute.path.length === 0) {
    console.error('No route available for USDC -> APT. Raw response:');
    console.dir(quote, { depth: null });
    return;
  }

  console.log('Route path:', bestRoute.path);
  console.log('Amount in (base) :', bestRoute.amountIn);
  console.log('Amount out (base):', bestRoute.amountOut);

  const estApt = formatFromBaseUnits(bestRoute.amountOut ?? '0', APT_DECIMALS);
  console.log(`Estimated output : ~${estApt} APT`);

  if (!submit) {
    console.log('Dry run only (pass --submit true to execute).');
    return;
  }

  const privateKeyHex = process.env.PRIVATE_KEY?.trim();
  if (!privateKeyHex) {
    throw new Error('Missing PRIVATE_KEY in environment');
  }

  const account = Account.fromPrivateKey({ privateKey: new Ed25519PrivateKey(privateKeyHex) });

  const poolRoute = Array.isArray(bestRoute.path) ? bestRoute.path : [];
  if (poolRoute.length === 0) {
    throw new Error('Route returned no pool path');
  }

  const minOutBase = bestRoute.amountOut
    ? (BigInt(bestRoute.amountOut) * BigInt(10000 - slippageBps)) / BigInt(10000)
    : BigInt(0);
  if (minOutBase <= 0n) {
    throw new Error('Quote returned zero output; aborting.');
  }

  const payload = sdk.Swap.swapTransactionPayload({
    currencyA: USDC_FA,
    currencyB: APT_FA,
    currencyAAmount: amountBase,
    currencyBAmount: minOutBase.toString(),
    slippage: slippageBps / 100,
    poolRoute,
    recipient: account.accountAddress.toString(),
  });

  const aptos = new Aptos({ network: 'mainnet', apiKey: process.env.APTOS_API_KEY });
  const rawTxn = await aptos.transaction.build.simple({
    sender: account.accountAddress,
    data: payload,
  });

  console.log('Submitting swap transaction...');
  const pending = await aptos.signAndSubmitTransaction({ signer: account, transaction: rawTxn });
  console.log('Pending hash:', pending.hash);
  const committed = await aptos.waitForTransaction({ transactionHash: pending.hash });
  console.log('Swap confirmed at version:', committed.version);
  console.log(
    `Swapped ${amountHuman} USDC for ≈${estApt} APT (min guaranteed ${formatFromBaseUnits(minOutBase.toString(), APT_DECIMALS)}).`,
  );
}

main().catch((error) => {
  console.error('USDC -> APT swap error:', error);
  process.exitCode = 1;
});
