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
import { borrowWithAries } from '../borrow/aries.js';

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
  ariesCoreAddress?: string;
  ariesModuleName?: string;
  ariesWithdrawModuleName?: string;
  ariesProfile?: string;
  ariesBorrowType?: string;
  ariesBorrowKind?: string;
  ariesWaitForSuccess?: string;
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
const APT_TYPE_TAG = '0x1::aptos_coin::AptosCoin';

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
      case 'aries-core-address':
        result.ariesCoreAddress = next;
        i += 1;
        break;
      case 'aries-module-name':
        result.ariesModuleName = next;
        i += 1;
        break;
      case 'aries-withdraw-module-name':
        result.ariesWithdrawModuleName = next;
        i += 1;
        break;
      case 'aries-profile':
        result.ariesProfile = next;
        i += 1;
        break;
      case 'aries-borrow-type':
        result.ariesBorrowType = next;
        i += 1;
        break;
      case 'aries-borrow-kind':
        result.ariesBorrowKind = next;
        i += 1;
        break;
      case 'aries-wait-for-success':
        result.ariesWaitForSuccess = next;
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
  const spotFromFa = normalizeFa(args.spotFromFa ?? defaultMap.usdc);
  const spotToFa = normalizeFa(args.spotToFa ?? defaultMap.apt);
  const spotOutDecimals = args.spotOutDecimals ?? APT_DECIMALS;
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

  const outstandingLoan = await fetchOutstandingLoan({ aptos, account, args });
  if (outstandingLoan === 0n) {
    console.log('No outstanding Aries APT loan detected.');
  } else {
    console.log('Outstanding APT loan (base units):', outstandingLoan.toString());
  }

  const spotOutBase = args.spotOut
    ? toBaseUnits(args.spotOut, spotOutDecimals, 'spot-out')
    : outstandingLoan;
  if (spotOutBase === 0n) {
    console.log('No buy-back required; skipping spot leg.');
  }

  const quote = spotOutBase === 0n
    ? null
    : await sdk.Swap.estToAmount({
      from: spotFromFa,
      to: spotToFa,
      amount: spotOutBase.toString(),
      safeMode,
    });

  let amountInBase = 0n;
  let amountOutBase = 0n;
  let routePath: any[] | undefined;

  if (quote) {
    const bestRoute = (quote as any)?.bestRoute ?? quote;
    if (!bestRoute?.path || bestRoute.path.length === 0) {
      console.error('Hyperion returned no route. Raw response:');
      console.dir(quote, { depth: null });
      return;
    }
    amountInBase = BigInt(bestRoute.amountIn ?? 0);
    amountOutBase = BigInt(bestRoute.amountOut ?? 0);
    routePath = bestRoute.path;

    console.log('\n--- Hyperion Quote (USDC -> APT amount-out) ---');
    console.log('Network       :', hyperionNetwork);
    console.log('Output token  :', spotToFa);
    console.log('Output amount :', args.spotOut ?? formatBaseAmount(spotOutBase, spotOutDecimals));
    console.log('Input token   :', spotFromFa);
    console.log('Amount in (base)  :', bestRoute.amountIn);
    console.log('Amount out (base) :', bestRoute.amountOut);
  }

  if (submitSpot && quote) {
    const payload = await sdk.Swap.swapTransactionPayload({
      currencyA: spotFromFa,
      currencyB: spotToFa,
      currencyAAmount: amountInBase.toString(),
      currencyBAmount: amountOutBase.toString(),
      slippage: slippageBps / 100,
      poolRoute: routePath ?? [],
      recipient: account.accountAddress.toString(),
    });

    await submitAptosTransaction({ aptos, account, payload, label: 'Hyperion USDC->APT swap' });
  } else if (quote) {
    console.log('Spot leg dry run (pass --submit-spot true to execute swap + repay).');
  }

  if (submitSpot) {
    const updatedLoan = await fetchOutstandingLoan({ aptos, account, args });
    if (updatedLoan === 0n) {
      console.log('Outstanding loan already cleared; skipping repay.');
    } else {
      await repayAriesLoan({
        aptos,
        account,
        args,
        repayAmount: updatedLoan,
      });
    }
  }

  const positions = await merkle.getPositions({ address: account.accountAddress });
  const existing = positions.find((pos) => normalizePair(pos.pairType) === perpPair);
  if (!existing || existing.size === 0n) {
    console.log(`No open Merkle position found for ${perpPair}.`);
    return;
  }

  if (!existing.isLong) {
    console.warn(`Existing ${perpPair} position is not long; skipping close.`);
    return;
  }

  console.log('\n--- Merkle Long Perp Close ---');
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
    isLong: true,
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
  console.error('Close short-spot-long-perp error:', error);
  process.exitCode = 1;
});

type LoanContext = {
  aptos: Aptos;
  account: Account;
  args: Args;
};

type RepayContext = {
  aptos: Aptos;
  account: Account;
  args: Args;
  repayAmount: bigint;
};

async function fetchOutstandingLoan(context: LoanContext): Promise<bigint> {
  const { aptos, account, args } = context;
  const coreAddress = (args.ariesCoreAddress ?? process.env.ARIES_CORE_ADDRESS)?.toLowerCase();
  if (!coreAddress) {
    console.warn('ARIES_CORE_ADDRESS not set; assuming zero outstanding loan.');
    return 0n;
  }
  const profile = args.ariesProfile ?? process.env.ARIES_PROFILE_NAME ?? 'main';
  try {
    const result = await callAriesView({
      aptos,
      coreAddress,
      module: 'profile',
      functionName: 'profile_loan',
      typeArguments: [args.ariesBorrowType ?? process.env.ARIES_BORROW_TYPE ?? APT_TYPE_TAG],
      functionArguments: [account.accountAddress.toString(), profile],
    });
    const values = Array.isArray(result) ? result : [];
    const mantissaRaw = values[1] ?? '0';
    const mantissa = BigInt(mantissaRaw);
    return mantissa / (10n ** 19n);
  } catch (error) {
    console.warn('Unable to fetch Aries loan via view:', (error as Error).message);
    return 0n;
  }
}

async function repayAriesLoan(context: RepayContext) {
  const { aptos, account, args, repayAmount } = context;
  if (repayAmount === 0n) {
    console.log('Repay amount is zero; skipping Aries repay.');
    return;
  }

  const coreAddress = args.ariesCoreAddress ?? process.env.ARIES_CORE_ADDRESS;
  if (!coreAddress) {
    throw new Error('Set ARIES_CORE_ADDRESS or pass --aries-core-address to repay.');
  }

  const moduleName = args.ariesModuleName ?? process.env.ARIES_MODULE_NAME ?? 'controller';
  const withdrawModule = args.ariesWithdrawModuleName ?? process.env.ARIES_WITHDRAW_MODULE ?? moduleName;
  const profileName = args.ariesProfile ?? process.env.ARIES_PROFILE_NAME ?? 'main';
  const borrowType = args.ariesBorrowType ?? process.env.ARIES_BORROW_TYPE ?? APT_TYPE_TAG;
  const borrowKind = inferKind(args.ariesBorrowKind ?? process.env.ARIES_BORROW_KIND, borrowType, 'coin');
  const waitForSuccess = parseBool(args.ariesWaitForSuccess ?? process.env.ARIES_WAIT_FOR_SUCCESS) ?? true;

  console.log('\n[aries] Repay request');
  console.log('  core address :', coreAddress);
  console.log('  module       :', moduleName);
  console.log('  withdraw mod :', withdrawModule);
  console.log('  profile      :', profileName);
  console.log('  repay amount :', repayAmount.toString());

  await borrowWithAries({
    aptos,
    account,
    coreAddress,
    moduleName,
    withdrawModuleName: withdrawModule,
    profileName,
    collateralType: borrowType,
    collateralAmount: '0',
    borrowType,
    borrowAmount: repayAmount.toString(),
    collateralKind: borrowKind,
    borrowKind,
    skipRegistration: true,
    skipDeposit: true,
    repayOnly: true,
    allowBorrow: false,
    waitForSuccess,
  });
}

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

async function callAriesView(args: {
  aptos: Aptos;
  coreAddress: string;
  module: string;
  functionName: string;
  typeArguments: string[];
  functionArguments: any[];
}) {
  const { aptos, coreAddress, module, functionName, typeArguments, functionArguments } = args;
  const fqn = `${coreAddress}::${module}::${functionName}`;
  return aptos.view({ payload: { function: fqn, typeArguments, functionArguments } });
}

function normalizePair(pairType: string): string {
  const parts = pairType.split('::');
  return parts[parts.length - 1] ?? pairType;
}

function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return undefined;
}

function toBaseUnits(value: string, decimals: number, label: string): bigint {
  const trimmed = value.trim();
  const numeric = Number(trimmed);
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new Error(`${label} must be a non-negative number.`);
  }
  return BigInt(Math.round(numeric * 10 ** decimals));
}

function formatBaseAmount(value: bigint, decimals: number): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = value / divisor;
  const frac = value % divisor;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole.toString()}.${fracStr}`;
}

function inferKind(value: string | undefined, typeTag: string, defaultKind: 'coin' | 'fa'): 'coin' | 'fa' {
  if (value) {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'coin' || normalized === 'fa') {
      return normalized;
    }
    throw new Error(`Invalid token kind '${value}'. Use 'coin' or 'fa'.`);
  }

  if (typeTag.includes('::fungible_asset::') || typeTag.endsWith('::coin::T')) {
    return 'fa';
  }

  return defaultKind;
}
