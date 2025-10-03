import 'dotenv/config';
import WebSocket from 'ws';
import {
  Account,
  Aptos,
  Ed25519PrivateKey,
  Network as AptosNetwork,
} from '@aptos-labs/ts-sdk';
import { initHyperionSDK } from '@hyperionxyz/sdk';
import {
  MerkleClient,
  MerkleClientConfig,
} from '@merkletrade/ts-sdk';

type Args = {
  spotFromFa?: string;
  spotToFa?: string;
  spotOut?: string;
  spotOutDecimals?: number;
  slippageBps?: number;
  hyperionNetwork?: string;
  safeMode?: boolean;
  perpPair?: string;
  submitSpot?: boolean;
  submitPerp?: boolean;
  perpNetwork?: string;
};

const DEFAULT_FA: Record<'mainnet' | 'testnet', Record<'apt' | 'usdc', string>> = {
  mainnet: {
    apt: '0xa',
    usdc: '0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b',
  },
  testnet: {
    apt: '0xa',
    usdc: '0xf42db730eb3286e430e47d7bd4449e4dd687b1165039dedf990c56304f723987',
  },
};

const APT_DECIMALS = 8;
const USDC_DECIMALS = 6;

function parseArgs(argv: string[]): Args {
  const result: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    switch (key) {
      case 'spot-from-fa':
        result.spotFromFa = next;
        i += 1;
        break;
      case 'spot-to-fa':
        result.spotToFa = next;
        i += 1;
        break;
      case 'spot-out':
        result.spotOut = next;
        i += 1;
        break;
      case 'spot-out-decimals':
        result.spotOutDecimals = Number(next);
        i += 1;
        break;
      case 'slippage-bps':
        result.slippageBps = Number(next);
        i += 1;
        break;
      case 'hyperion-network':
        result.hyperionNetwork = next;
        i += 1;
        break;
      case 'safe-mode':
        result.safeMode = next.toLowerCase() !== 'false';
        i += 1;
        break;
      case 'perp-pair':
        result.perpPair = next;
        i += 1;
        break;
      case 'submit-spot':
        result.submitSpot = next?.toLowerCase() === 'true';
        i += 1;
        break;
      case 'submit-perp':
        result.submitPerp = next?.toLowerCase() === 'true';
        i += 1;
        break;
      case 'perp-network':
        result.perpNetwork = next;
        i += 1;
        break;
      default:
        break;
    }
  }
  return result;
}

function normalizeFa(address?: string): string {
  if (!address) return '';
  const match = /^0x0*([0-9a-fA-F]+)$/.exec(address);
  return match ? `0x${match[1].toLowerCase()}` : address;
}

function ensureWebSocketGlobal() {
  const globalRef = globalThis as { WebSocket?: typeof WebSocket };
  if (!globalRef.WebSocket) {
    globalRef.WebSocket = WebSocket as unknown as typeof WebSocket;
  }
}

export async function main() {
  const args = parseArgs(process.argv.slice(2));

  const hyperionNetwork = (args.hyperionNetwork ?? 'mainnet').toLowerCase();
  if (hyperionNetwork !== 'mainnet' && hyperionNetwork !== 'testnet') {
    throw new Error(`Unsupported Hyperion network '${hyperionNetwork}'. Use 'mainnet' or 'testnet'.`);
  }
  const defaultMap = DEFAULT_FA[hyperionNetwork === 'testnet' ? 'testnet' : 'mainnet'];
  const spotFromFa = normalizeFa(args.spotFromFa ?? defaultMap.apt);
  const spotToFa = normalizeFa(args.spotToFa ?? defaultMap.usdc);
  const spotOutDecimals = args.spotOutDecimals ?? USDC_DECIMALS;
  const slippageBps = args.slippageBps ?? 50;
  const safeMode = args.safeMode ?? false;
  const perpPair = args.perpPair ?? 'BTC_USD';
  const submitSpot = args.submitSpot ?? true; // Default to true for close operations
  const submitPerp = args.submitPerp ?? true; // Default to true for close operations
  const perpNetwork = (args.perpNetwork ?? 'mainnet').toLowerCase();

  const sdk = initHyperionSDK({
    network:
      hyperionNetwork === 'testnet'
        ? AptosNetwork.TESTNET
        : AptosNetwork.MAINNET,
    APTOS_API_KEY: process.env.APTOS_API_KEY ?? '',
  });

  ensureWebSocketGlobal();

  const privateKeyHex = process.env.PRIVATE_KEY?.trim();
  if (!privateKeyHex) {
    throw new Error('Missing PRIVATE_KEY in environment.');
  }
  const privateKey = new Ed25519PrivateKey(privateKeyHex);
  const account = Account.fromPrivateKey({ privateKey });

  let merkleConfig;
  if (perpNetwork === 'mainnet') {
    merkleConfig = await MerkleClientConfig.mainnet();
  } else if (perpNetwork === 'testnet') {
    merkleConfig = await MerkleClientConfig.testnet();
  } else {
    throw new Error(`Unsupported perp network '${perpNetwork}'. Use 'mainnet' or 'testnet'.`);
  }
  const merkle = new MerkleClient(merkleConfig);
  const aptos = new Aptos(merkleConfig.aptosConfig);

  // Get spot amount from args or use existing position size
  const spotOutBase = args.spotOut
    ? BigInt(Math.round(Number(args.spotOut) * 10 ** spotOutDecimals))
    : undefined;

  let amountInBase = 0n;
  let amountOutBase = 0n;
  let routePath: any[] | undefined;

  if (spotOutBase && spotOutBase > 0n) {
    const quote = await sdk.Swap.estToAmount({
      from: spotFromFa,
      to: spotToFa,
      amount: spotOutBase.toString(),
      safeMode,
    });

    const bestRoute = (quote as any)?.bestRoute ?? quote;
    if (!bestRoute?.path || bestRoute.path.length === 0) {
      console.error('Hyperion returned no route. Raw response:');
      console.dir(quote, { depth: null });
      return;
    }

    amountInBase = BigInt(bestRoute.amountIn ?? 0);
    amountOutBase = BigInt(bestRoute.amountOut ?? 0);
    routePath = bestRoute.path;

    console.log('\n--- Hyperion Quote (APT -> USDC amount-out) ---');
    console.log('Network       :', hyperionNetwork);
    console.log('Output token  :', spotToFa);
    console.log('Output amount :', args.spotOut);
    console.log('Input token   :', spotFromFa);
    console.log('Amount in (base)  :', bestRoute.amountIn);
    console.log('Amount out (base) :', bestRoute.amountOut);
  }

  if (submitSpot && amountInBase > 0n) {
    const payload = await sdk.Swap.swapTransactionPayload({
      currencyA: spotFromFa,
      currencyB: spotToFa,
      currencyAAmount: amountInBase.toString(),
      currencyBAmount: amountOutBase.toString(),
      slippage: slippageBps / 100,
      poolRoute: routePath ?? [],
      recipient: account.accountAddress.toString(),
    });

    await submitAptosTransaction({ aptos, account, payload, label: 'Hyperion APT->USDC swap' });
  } else if (amountInBase > 0n) {
    console.log('Spot leg dry run (pass --submit-spot true to execute swap).');
  }

  // Close short perp position
  const positions = await merkle.getPositions({ address: account.accountAddress });
  const existing = positions.find((pos) => normalizePair(pos.pairType) === perpPair);
  if (!existing || existing.size === 0n) {
    console.log(`No open Merkle position found for ${perpPair}.`);
    return;
  }

  if (existing.isLong) {
    console.warn(`Existing ${perpPair} position is not short; skipping close.`);
    return;
  }

  console.log('\n--- Merkle Short Perp Close ---');
  console.log('Pair            :', perpPair);
  console.log('Open size (6d)  :', existing.size.toString());
  console.log('Collateral (6d) :', existing.collateral.toString());

  // Always close perp when running the close script
  if (!submitPerp) {
    console.log('Perp close skipped (--submit-perp false was explicitly passed).');
    return;
  }

  const payload = await merkle.payloads.placeMarketOrder({
    pair: perpPair,
    userAddress: account.accountAddress,
    sizeDelta: existing.size,
    collateralDelta: 0n,
    isLong: false,
    isIncrease: false,
  });

  const rawTxn = await aptos.transaction.build.simple({
    sender: account.accountAddress,
    data: payload,
  });

  const pending = await aptos.signAndSubmitTransaction({ signer: account, transaction: rawTxn });
  console.log('Perp close pending hash:', pending.hash);
  const committed = await aptos.waitForTransaction({ transactionHash: pending.hash });
  console.log('Perp close confirmed at version:', committed.version);
}

main().catch((error) => {
  console.error('Close long-spot-short-perp error:', error);
  process.exitCode = 1;
});

async function submitAptosTransaction(args: {
  aptos: Aptos;
  account: Account;
  payload: any;
  label: string;
}) {
  const { aptos, account, payload, label } = args;
  const rawTxn = await aptos.transaction.build.simple({
    sender: account.accountAddress,
    data: payload,
  });
  const pending = await aptos.signAndSubmitTransaction({ signer: account, transaction: rawTxn });
  console.log(`${label} pending hash:`, pending.hash);
  const committed = await aptos.waitForTransaction({ transactionHash: pending.hash });
  console.log(`${label} confirmed at version:`, committed.version);
}

function normalizePair(pairType: string): string {
  const parts = pairType.split('::');
  return parts[parts.length - 1] ?? pairType;
}
