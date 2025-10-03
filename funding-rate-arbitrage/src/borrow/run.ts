import 'dotenv/config';
import {
  Account,
  Aptos,
  AptosConfig,
  Ed25519PrivateKey,
  Network,
} from '@aptos-labs/ts-sdk';

import { borrowWithAries } from './aries.js';

const USDC_FA_TYPE = '0xf22bede237a07e121b56d91a491eb7bcdfd1f5907926a9e58338f964a01b17fa::asset::USDC';
const WRAPPED_USDC_TYPE = '0x9770fa9c725cbd97eb50b2be5f7416efdfd1f1554beb0750d4dae4c64e860da3::wrapped_coins::WrappedUSDC';
const APT_TYPE_TAG = '0x1::aptos_coin::AptosCoin';
const USDC_DECIMALS = 6;
const APT_DECIMALS = 8;

type CliArgs = {
  coreAddress?: string;
  moduleName?: string;
  registerModule?: string;
  depositModule?: string;
  withdrawModule?: string;
  collateralKind?: string;
  collateralType?: string;
  collateralFaType?: string;
  wrappedCollateralType?: string;
  collateralAmount?: string;
  borrowType?: string;
  borrowAmount?: string;
  collateralUsdc?: string;
  borrowApt?: string;
  borrowKind?: string;
  profile?: string;
  skipRegistration?: boolean;
  skipDeposit?: boolean;
  repayOnly?: boolean;
  allowBorrow?: boolean;
  network?: string;
  waitForSuccess?: boolean;
};

function parseArgs(argv: string[]): CliArgs {
  const result: CliArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    const hasValue = next !== undefined && !next.startsWith('--');

    switch (key) {
      case 'core-address':
        if (hasValue) {
          result.coreAddress = next;
          i += 1;
        }
        break;
      case 'collateral-type':
        if (hasValue) {
          result.collateralType = next;
          i += 1;
        }
        break;
      case 'module-name':
        if (hasValue) {
          result.moduleName = next;
          i += 1;
        }
        break;
      case 'register-module':
        if (hasValue) {
          result.registerModule = next;
          i += 1;
        }
        break;
      case 'deposit-module':
        if (hasValue) {
          result.depositModule = next;
          i += 1;
        }
        break;
      case 'withdraw-module':
        if (hasValue) {
          result.withdrawModule = next;
          i += 1;
        }
        break;
      case 'collateral-kind':
        if (hasValue) {
          result.collateralKind = next;
          i += 1;
        }
        break;
      case 'collateral-fa-type':
        if (hasValue) {
          result.collateralFaType = next;
          i += 1;
        }
        break;
      case 'wrapped-collateral-type':
        if (hasValue) {
          result.wrappedCollateralType = next;
          i += 1;
        }
        break;
      case 'collateral-amount':
        if (hasValue) {
          result.collateralAmount = next;
          i += 1;
        }
        break;
      case 'borrow-type':
        if (hasValue) {
          result.borrowType = next;
          i += 1;
        }
        break;
      case 'borrow-amount':
        if (hasValue) {
          result.borrowAmount = next;
          i += 1;
        }
        break;
      case 'collateral-usdc':
        if (hasValue) {
          result.collateralUsdc = next;
          i += 1;
        }
        break;
      case 'borrow-apt':
        if (hasValue) {
          result.borrowApt = next;
          i += 1;
        }
        break;
      case 'borrow-kind':
        if (hasValue) {
          result.borrowKind = next;
          i += 1;
        }
        break;
      case 'profile':
        if (hasValue) {
          result.profile = next;
          i += 1;
        }
        break;
      case 'network':
        if (hasValue) {
          result.network = next;
          i += 1;
        }
        break;
      case 'skip-registration':
        result.skipRegistration = hasValue ? next.toLowerCase() === 'true' : true;
        if (hasValue) i += 1;
        break;
      case 'skip-deposit':
        result.skipDeposit = hasValue ? next.toLowerCase() === 'true' : true;
        if (hasValue) i += 1;
        break;
      case 'repay-only':
        result.repayOnly = hasValue ? next.toLowerCase() === 'true' : true;
        if (hasValue) i += 1;
        break;
      case 'allow-borrow':
        if (hasValue) {
          result.allowBorrow = next.toLowerCase() === 'true';
          i += 1;
        } else {
          result.allowBorrow = true;
        }
        break;
      case 'wait-for-success':
        if (hasValue) {
          result.waitForSuccess = next.toLowerCase() === 'true';
          i += 1;
        } else {
          result.waitForSuccess = true;
        }
        break;
      case 'no-wait':
        result.waitForSuccess = false;
        break;
      default:
        break;
    }
  }

  return result;
}

function resolveNetwork(value?: string): Network {
  const normalized = (value ?? process.env.APTOS_NETWORK ?? 'mainnet').toLowerCase();
  if (normalized === 'mainnet') return Network.MAINNET;
  if (normalized === 'testnet') return Network.TESTNET;
  throw new Error(`Unsupported Aptos network '${normalized}'. Use 'mainnet' or 'testnet'.`);
}

function envBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return undefined;
}

function parseHumanAmount(value: string | undefined, decimals: number, label: string): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const numeric = Number(trimmed);
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new Error(`${label} must be a non-negative number.`);
  }
  const baseUnits = BigInt(Math.round(numeric * 10 ** decimals));
  return baseUnits.toString();
}

async function main() {
  const cli = parseArgs(process.argv.slice(2));

  const coreAddress = cli.coreAddress ?? process.env.ARIES_CORE_ADDRESS;
  if (!coreAddress) {
    throw new Error('Set ARIES_CORE_ADDRESS or pass --core-address.');
  }

  const moduleName = cli.moduleName ?? process.env.ARIES_MODULE_NAME ?? 'controller';
  const registerModule = cli.registerModule ?? process.env.ARIES_REGISTER_MODULE ?? moduleName;

  const collateralTypeInput = cli.collateralType ?? process.env.ARIES_COLLATERAL_TYPE;
  const collateralType = collateralTypeInput ?? USDC_FA_TYPE;
  if (!collateralType) {
    throw new Error('Set ARIES_COLLATERAL_TYPE or pass --collateral-type.');
  }

  const collateralAmount = cli.collateralAmount
    ?? parseHumanAmount(cli.collateralUsdc ?? process.env.ARIES_COLLATERAL_USDC, USDC_DECIMALS, 'ARIES_COLLATERAL_USDC')
    ?? process.env.ARIES_COLLATERAL_AMOUNT;
  if (!collateralAmount) {
    throw new Error('Set ARIES_COLLATERAL_AMOUNT, ARIES_COLLATERAL_USDC, or pass --collateral-amount / --collateral-usdc.');
  }

  const collateralKind = inferKind(cli.collateralKind ?? process.env.ARIES_COLLATERAL_KIND, collateralType, 'fa');
  const wrappedCollateralOverride = cli.wrappedCollateralType ?? process.env.ARIES_WRAPPED_COLLATERAL_TYPE;
  const wrappedCollateralType = wrappedCollateralOverride ?? resolveWrappedType(collateralType, collateralKind);
  if (collateralKind === 'fa' && !wrappedCollateralType) {
    throw new Error(`Unsupported FA collateral type '${collateralType}'. Provide --wrapped-collateral-type to map it.`);
  }
  const entryCollateralType = wrappedCollateralType ?? collateralType;
  const defaultDepositModule = moduleName;
  const depositModule = cli.depositModule ?? process.env.ARIES_DEPOSIT_MODULE ?? defaultDepositModule;
  const withdrawModule = cli.withdrawModule ?? process.env.ARIES_WITHDRAW_MODULE ?? moduleName;

  const profileName = cli.profile ?? process.env.ARIES_PROFILE_NAME ?? 'main';

  const skipRegistration = cli.skipRegistration ?? envBool(process.env.ARIES_SKIP_REGISTRATION) ?? false;
  const skipDeposit = cli.skipDeposit ?? envBool(process.env.ARIES_SKIP_DEPOSIT) ?? false;
  const repayOnly = cli.repayOnly ?? envBool(process.env.ARIES_REPAY_ONLY) ?? false;

  const borrowType = cli.borrowType ?? process.env.ARIES_BORROW_TYPE ?? APT_TYPE_TAG;
  if (!borrowType) {
    throw new Error('Set ARIES_BORROW_TYPE or pass --borrow-type.');
  }

  let borrowAmount = cli.borrowAmount
    ?? parseHumanAmount(cli.borrowApt ?? process.env.ARIES_BORROW_APT, APT_DECIMALS, 'ARIES_BORROW_APT')
    ?? process.env.ARIES_BORROW_AMOUNT;

  if (!borrowAmount) {
    borrowAmount = repayOnly ? '0' : undefined;
    if (borrowAmount === undefined) {
      throw new Error('Set ARIES_BORROW_AMOUNT, ARIES_BORROW_APT, or pass --borrow-amount / --borrow-apt.');
    }
  }

  const borrowKind = inferKind(cli.borrowKind ?? process.env.ARIES_BORROW_KIND, borrowType, 'coin');

  const allowBorrow = repayOnly
    ? false
    : cli.allowBorrow ?? envBool(process.env.ARIES_ALLOW_BORROW) ?? true;
  const waitForSuccess = cli.waitForSuccess ?? envBool(process.env.ARIES_WAIT_FOR_SUCCESS) ?? true;

  const network = resolveNetwork(cli.network);

  const config = new AptosConfig({
    network,
    fullnode: process.env.APTOS_FULLNODE_URL,
    indexer: process.env.APTOS_INDEXER_URL,
  });
  const aptos = new Aptos(config);

  const privateKeyHex = process.env.PRIVATE_KEY?.trim();
  if (!privateKeyHex) {
    throw new Error('Set PRIVATE_KEY in your environment.');
  }

  const account = Account.fromPrivateKey({ privateKey: new Ed25519PrivateKey(privateKeyHex) });

  console.log('Aries borrow request:', {
    network,
    address: account.accountAddress.toString(),
    coreAddress,
    moduleName,
    registerModule,
    depositModule,
    withdrawModule,
    profileName,
    collateralFaType: collateralKind === 'fa' ? collateralType : undefined,
    collateralType: entryCollateralType,
    collateralAmount,
    collateralKind,
    wrappedCollateralType,
    borrowType,
    borrowAmount,
    borrowKind,
    skipRegistration,
    skipDeposit,
    repayOnly,
    allowBorrow,
    waitForSuccess,
  });

  const result = await borrowWithAries({
    aptos,
    account,
    coreAddress,
    moduleName,
    registerModuleName: registerModule,
    depositModuleName: depositModule,
    withdrawModuleName: withdrawModule,
    profileName,
    collateralType: entryCollateralType,
    collateralAmount,
    wrappedCollateralType,
    borrowType,
    borrowAmount,
    collateralKind,
    borrowKind,
    skipRegistration,
    skipDeposit,
    repayOnly,
    allowBorrow,
    waitForSuccess,
  });

  console.log('Aries borrow completed:', result);
}

main().catch((error) => {
  console.error('Aries borrow script error:', error);
  process.exitCode = 1;
});

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

function resolveWrappedType(typeTag: string, kind: 'coin' | 'fa'): string | undefined {
  if (kind !== 'fa') return undefined;
  if (typeTag === USDC_FA_TYPE || typeTag === '0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b::coin::T') {
    return WRAPPED_USDC_TYPE;
  }
  return undefined;
}
