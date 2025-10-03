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

  let hyperionQuote = null;

  if (spotOutBase && spotOutBase > 0n) {
    const quote = await sdk.Swap.estToAmount({
      from: spotFromFa,
      to: spotToFa,
      amount: spotOutBase.toString(),
      safeMode,
    });

    const bestRoute = (quote as any)?.bestRoute ?? quote;
    if (!bestRoute?.path || bestRoute.path.length === 0) {
      const errorResult = {
        error: 'Hyperion returned no route',
        rawResponse: quote
      };
      console.log(JSON.stringify(errorResult, null, 2));
      return;
    }

    amountInBase = BigInt(bestRoute.amountIn ?? 0);
    amountOutBase = BigInt(bestRoute.amountOut ?? 0);
    routePath = bestRoute.path;

    hyperionQuote = {
      network: hyperionNetwork,
      outputToken: spotToFa,
      outputAmount: args.spotOut,
      inputToken: spotFromFa,
      amountIn: bestRoute.amountIn,
      amountOut: bestRoute.amountOut,
      routePath: routePath
    };
  }

  let spotExecution = null;

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

    spotExecution = {
      action: 'apt_swapped_for_usdc',
      hyperionQuote: hyperionQuote,
      slippageBps: slippageBps
    };
  } else if (amountInBase > 0n) {
    const dryRunResult = {
      action: 'dry_run',
      message: 'Spot leg dry run (pass --submit-spot true to execute swap).',
      hyperionQuote: hyperionQuote
    };
    console.log(JSON.stringify(dryRunResult, null, 2));
    return;
  }

  // Close short perp position
  const positions = await merkle.getPositions({ address: account.accountAddress });
  const existing = positions.find((pos) => normalizePair(pos.pairType) === perpPair);

  if (!existing || existing.size === 0n) {
    const noPositionResult = {
      action: 'abort',
      reason: 'no_open_position',
      pair: perpPair,
      message: `No open Merkle position found for ${perpPair}.`
    };
    console.log(JSON.stringify(noPositionResult, null, 2));
    return;
  }

  if (existing.isLong) {
    const wrongDirectionResult = {
      action: 'abort',
      reason: 'wrong_position_direction',
      pair: perpPair,
      isLong: existing.isLong,
      message: `Existing ${perpPair} position is not short; skipping close.`
    };
    console.log(JSON.stringify(wrongDirectionResult, null, 2));
    return;
  }

  const perpPosition = {
    pair: perpPair,
    openSize: existing.size.toString(),
    collateral: existing.collateral.toString(),
    direction: existing.isLong ? 'LONG' : 'SHORT'
  };

  if (!submitPerp) {
    const dryRunResult = {
      action: 'dry_run',
      message: 'Perp close skipped (--submit-perp false was explicitly passed).',
      perpPosition: perpPosition
    };
    console.log(JSON.stringify(dryRunResult, null, 2));
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
  const committed = await aptos.waitForTransaction({ transactionHash: pending.hash });

  const perpClose = {
    action: 'short_perp_position_closed',
    transactionHash: pending.hash,
    version: committed.version,
    pair: perpPair,
    sizeClosed: existing.size.toString(),
    direction: 'SHORT'
  };

  const executionResult = {
    action: 'arbitrage_closed',
    strategy: 'close_long_spot_short_perp',
    hyperionQuote: hyperionQuote,
    spotExecution: spotExecution,
    perpPosition: perpPosition,
    perpClose: perpClose
  };

  console.log(JSON.stringify(executionResult, null, 2));
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
  const committed = await aptos.waitForTransaction({ transactionHash: pending.hash });
  // Transaction details stored for JSON output
}

function normalizePair(pairType: string): string {
  const parts = pairType.split('::');
  return parts[parts.length - 1] ?? pairType;
}
