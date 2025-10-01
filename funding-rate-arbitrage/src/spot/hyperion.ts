import 'dotenv/config';
import {
  Account,
  Aptos,
  Ed25519PrivateKey,
  Network,
} from '@aptos-labs/ts-sdk';
import { initHyperionSDK } from '@hyperionxyz/sdk';

type ParsedArgs = {
  fromCoin?: string;
  toCoin?: string;
  amount?: string;
  decimals?: number;
  slippageBps?: number;
  submit?: boolean;
  network?: string;
  safeMode?: boolean;
  mode?: string;
};

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      if (key === 'submit') result.submit = true;
      continue;
    }
    i += 1;
    switch (key) {
      case 'from':
        result.fromCoin = next;
        break;
      case 'to':
        result.toCoin = next;
        break;
      case 'amount':
        result.amount = next;
        break;
      case 'decimals':
        result.decimals = Number(next);
        break;
      case 'slippage-bps':
        result.slippageBps = Number(next);
        break;
      case 'network':
        result.network = next;
        break;
      case 'safe-mode':
        result.safeMode = next.toLowerCase() !== 'false';
        break;
      case 'mode':
        result.mode = next;
        break;
      case 'submit':
        result.submit = next === 'true';
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

function resolveNetwork(value: string | undefined): Network {
  const resolved = (value ?? process.env.HYPERION_NETWORK ?? 'mainnet').toLowerCase();
  if (resolved === 'mainnet') {
    return Network.MAINNET;
  }
  if (resolved === 'testnet') {
    return Network.TESTNET;
  }
  throw new Error(`Unsupported Hyperion network '${resolved}'. Use 'mainnet' or 'testnet'.`);
}

function normalizeAsset(address: string): string {
  if (!address) return address;
  const match = /^0x0*([0-9a-fA-F]+)$/.exec(address);
  if (match) {
    return `0x${match[1].toLowerCase()}`;
  }
  return address;
}

async function main() {
  const {
    fromCoin = '0x1::aptos_coin::AptosCoin',
    toCoin = '0x33a8693758d1d28a9305946c7758b7548a04736c35929eac22eb0de2a865275d::fa_box::W_USDC',
    amount = '1',
    decimals = 8,
    slippageBps = 50,
    submit = false,
    network: cliNetwork,
    safeMode = true,
    mode: cliMode,
  } = parseArgs(process.argv.slice(2));

  const network = resolveNetwork(cliNetwork);
  const mode = cliMode?.toLowerCase() === 'from' ? 'from' : 'to';

  const normalizedFrom = normalizeAsset(fromCoin);
  const normalizedTo = normalizeAsset(toCoin);

  const sdk = initHyperionSDK({
    network,
    APTOS_API_KEY: process.env.APTOS_API_KEY ?? '',
  });

  const baseAmount = toBaseUnits(amount, decimals);

  console.log('--- Hyperion Swap Quote ---');
  console.log('Network:', network);
  console.log('From coin:', normalizedFrom);
  console.log('To coin  :', normalizedTo);
  console.log('Amount   :', amount, `(base units: ${baseAmount})`);
  console.log('Slippage :', `${slippageBps} bps`);

  const estimateArgs = {
    from: normalizedFrom,
    to: normalizedTo,
    amount: baseAmount,
    safeMode,
  } as const;

  const estimate = mode === 'to'
    ? await sdk.Swap.estToAmount(estimateArgs)
    : await sdk.Swap.estFromAmount(estimateArgs);

  console.log('Raw estimate:', JSON.stringify(estimate, null, 2));

  const bestRoute = (estimate as any)?.bestRoute ?? estimate;

  if (!bestRoute?.path) {
    throw new Error('No route available for the requested swap.');
  }

  console.log('Route response:');
  console.dir(bestRoute, { depth: null });
  console.log('Route metadata:', {
    flag: (estimate as any)?.flag,
    amountIn: bestRoute?.amountIn,
    amountOut: bestRoute?.amountOut,
    path: bestRoute?.path,
  });

  if (!submit) {
    console.log('Dry run only (pass --submit true to execute).');
    return;
  }

  const privateKeyHex = process.env.PRIVATE_KEY?.trim();
  if (!privateKeyHex) {
    throw new Error('Missing PRIVATE_KEY in environment');
  }

  const privateKey = new Ed25519PrivateKey(privateKeyHex);
  const account = Account.fromPrivateKey({ privateKey });

  const slippagePercent = Number(slippageBps) / 100;
  const poolRoute = Array.isArray(bestRoute?.path) ? bestRoute.path : [];
  const amountIn = bestRoute?.amountIn ?? baseAmount;
  const amountOut = bestRoute?.amountOut ?? baseAmount;

  if (poolRoute.length === 0) {
    throw new Error('Route returned no pool path');
  }

  const currencyAAmount = amountIn;
  const currencyBAmount = amountOut;

  const payload = sdk.Swap.swapTransactionPayload({
    currencyA: normalizedFrom,
    currencyB: normalizedTo,
    currencyAAmount,
    currencyBAmount,
    slippage: slippagePercent,
    poolRoute,
    recipient: account.accountAddress.toString(),
  });
  console.log('Transaction payload ready.');

  const aptos = new Aptos({
    network: network === Network.MAINNET ? 'mainnet' : 'testnet',
    apiKey: process.env.APTOS_API_KEY,
  });

  console.log('Submitting swap transaction...');
  const rawTxn = await aptos.transaction.build.simple({
    sender: account.accountAddress,
    data: payload,
  });

  const pending = await aptos.signAndSubmitTransaction({ signer: account, transaction: rawTxn });
  console.log('Pending hash:', pending.hash);
  const committed = await aptos.waitForTransaction({ transactionHash: pending.hash });
  console.log('Swap confirmed at version:', committed.version);
  console.log('Gas used:', committed.gas_used);
}

main().catch((error) => {
  console.error('Hyperion script error:', error);
  process.exitCode = 1;
});
