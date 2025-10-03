import 'dotenv/config';
import WebSocket from 'ws';
import {
  Account,
  Aptos,
  Ed25519PrivateKey,
  Network as AptosNetwork,
} from '@aptos-labs/ts-sdk';
import { initHyperionSDK, type HyperionSDK } from '@hyperionxyz/sdk';
import {
  MerkleClient,
  MerkleClientConfig,
  calcFundingInfo,
} from '@merkletrade/ts-sdk';
import { borrowWithAries } from '../borrow/aries.js';
import {
  computeMinFundingBreakdown,
  computeBreakevenHoldDuration,
  type MinFundingInputs,
  type MinFundingBreakdown,
} from '../utils/minFunding';

// ============================================================================
// INTEREST & COST CALCULATION HELPERS
// ============================================================================

const RAY = 1e27;

function rayToDec(x: bigint): number {
  return Number(x) / RAY;
}

/**
 * Aave-style kink model APR (as decimal, e.g. 0.12 = 12% APR)
 */
export function borrowApr({
  U,
  Uopt,
  R0,
  slope1,
  slope2,
}: {
  U: number;
  Uopt: number;
  R0: number;
  slope1: number;
  slope2: number;
}): number {
  if (U < Uopt) {
    return R0 + (U / Uopt) * slope1;
  }
  const over = (U - Uopt) / (1 - Uopt);
  return R0 + slope1 + over * slope2;
}

/**
 * Convert APR (decimal) into projected interest
 */
export function projectInterest({
  principal,
  apr,
  days,
  compound = true,
}: {
  principal: number;
  apr: number;
  days: number;
  compound?: boolean;
}): { interest: number; endDebt: number } {
  const t = days / 365;
  const interest = compound
    ? principal * (Math.pow(1 + apr, t) - 1)
    : principal * apr * t;
  const endDebt = principal + interest;
  return { interest, endDebt };
}

async function getReserveConfig(aptos: Aptos, core: string, assetTag: string) {
  const typeA = `${core}::reserve::ReserveConfig<${assetTag}>`;
  const typeB = `${core}::reserve::ReserveConfig`;
  try {
    return await aptos.getAccountResource({
      accountAddress: core,
      resourceType: typeA,
    });
  } catch {
    return await aptos.getAccountResource({
      accountAddress: core,
      resourceType: typeB,
    });
  }
}

function extractRateParams(rc: any) {
  const data = rc?.data ?? rc;
  const base =
    data?.base_borrow_rate_ray != null
      ? rayToDec(BigInt(data.base_borrow_rate_ray))
      : Number(data?.base_borrow_rate ?? 0);

  const s1 =
    data?.variable_slope1_ray != null
      ? rayToDec(BigInt(data.variable_slope1_ray))
      : Number(data?.variable_slope1 ?? 0);

  const s2 =
    data?.variable_slope2_ray != null
      ? rayToDec(BigInt(data.variable_slope2_ray))
      : Number(data?.variable_slope2 ?? 0);

  const uopt =
    data?.optimal_utilization_ray != null
      ? rayToDec(BigInt(data.optimal_utilization_ray))
      : Number(data?.optimal_utilization ?? 0.8);

  return { R0: base, slope1: s1, slope2: s2, Uopt: uopt };
}

function extractUtilization(stats: any): number {
  const d = stats ?? {};
  if (d.utilization_ray != null) return rayToDec(BigInt(d.utilization_ray));

  const bor = BigInt(d?.total_borrow?.amount ?? 0n);
  const dep = BigInt(d?.total_deposit?.amount ?? 0n);
  const cash = dep > bor ? dep - bor : 0n;
  const denom = Number(cash + bor);
  return denom > 0 ? Number(bor) / denom : 0;
}

function constructTypeInfo(typeTag: string): any {
  // Parse type tag like "0x1::aptos_coin::AptosCoin"
  const parts = typeTag.split('::');
  if (parts.length !== 3) {
    throw new Error(`Invalid type tag: ${typeTag}`);
  }

  const [address, moduleName, structName] = parts;

  // Convert to hex bytes
  const moduleNameHex = '0x' + Buffer.from(moduleName).toString('hex');
  const structNameHex = '0x' + Buffer.from(structName).toString('hex');

  return {
    account_address: address,
    module_name: moduleNameHex,
    struct_name: structNameHex,
  };
}

async function getReserveStatsFor(
  aptos: Aptos,
  coreAddress: string,
  assetType: string,
) {
  const reserves = await aptos.getAccountResource({
    accountAddress: coreAddress,
    resourceType: `${coreAddress}::reserve::Reserves`,
  });

  const statsHandle =
    (reserves as any)?.data?.stats?.handle ??
    (reserves as any)?.stats?.handle;
  if (!statsHandle) throw new Error('Aries reserve stats handle not found');

  const typeInfo = constructTypeInfo(assetType);

  // Try generic first (ReserveStats<T>), as that's what Aries uses
  try {
    return await aptos.getTableItem({
      handle: statsHandle,
      data: {
        key_type: '0x1::type_info::TypeInfo',
        value_type: `${coreAddress}::reserve::ReserveStats<${assetType}>`,
        key: typeInfo,
      },
    });
  } catch (error) {
    // Fallback to non-generic
    return await aptos.getTableItem({
      handle: statsHandle,
      data: {
        key_type: '0x1::type_info::TypeInfo',
        value_type: `${coreAddress}::reserve::ReserveStats`,
        key: typeInfo,
i      },
    });
  }
}

export type ProfitabilityAnalysis = {
  isProfitable: boolean;
  hoursToBreakeven?: number;
  daysToBreakeven?: number;
  costs: {
    spotRoundTripBps: number;
    perpRoundTripBps: number;
    gasRoundTripBps: number;
    tradingCostPct: number; // One-time cost
    borrowInterestAprPct: number;
    borrowCostPctPerHour: number; // Recurring cost per hour
  };
  funding: {
    currentFundingPctPerHour: number;
    fundingIncomePctPerHour: number; // What we receive
    netIncomePctPerHour: number; // Funding - borrow cost
  };
};

/**
 * Analyzes profitability of short APT arbitrage strategy
 *
 * NOTE: Provide borrowAprPct manually by checking Aries UI or protocol
 * Fetching borrow rate from on-chain is complex due to Aries contract structure
 */
export async function analyzeShortAptProfitability({
  aptos,
  merkle,
  hyperionSdk,
  aptBorrowAmount,
  usdcTargetAmount,
  perpPair = 'APT_USD',
  borrowAprPct = 6,
  holdHours = 24,
  gasEstimateBps = 5,
}: {
  aptos: Aptos;
  merkle: MerkleClient;
  hyperionSdk: HyperionSDK;
  aptBorrowAmount: bigint;
  usdcTargetAmount: bigint;
  perpPair?: string;
  borrowAprPct?: number;
  holdHours?: number;
  gasEstimateBps?: number;
}): Promise<ProfitabilityAnalysis> {
  const APT_FA = '0xa';
  const USDC_FA = '0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b';

  // 1. Calculate spot round-trip cost
  const openQuote = await hyperionSdk.Swap.estToAmount({
    from: APT_FA,
    to: USDC_FA,
    amount: usdcTargetAmount.toString(),
    safeMode: false,
  });

  const openRoute = (openQuote as any)?.bestRoute ?? openQuote;
  const openUsdcReceived = BigInt(openRoute?.amountOut ?? 0);

  const closeQuote = await hyperionSdk.Swap.estToAmount({
    from: USDC_FA,
    to: APT_FA,
    amount: openUsdcReceived.toString(),
    safeMode: false,
  });

  const closeRoute = (closeQuote as any)?.bestRoute ?? closeQuote;
  const closeUsdcSpent = BigInt(closeRoute?.amountIn ?? 0);

  const usdcScale = 1_000_000;
  const openUsdc = Number(openUsdcReceived) / usdcScale;
  const closeUsdc = Number(closeUsdcSpent) / usdcScale;
  const spotRoundTripPct = openUsdc > 0 ? ((closeUsdc - openUsdc) / openUsdc) * 100 : 0;
  const spotRoundTripBps = Math.max(spotRoundTripPct * 100, 0);

  // 2. Calculate perp round-trip cost
  const pairInfo = await merkle.getPairInfo({ pairId: perpPair });
  const takerFeeFraction = Number(pairInfo.takerFee) / 1_000_000;
  const perpRoundTripBps = takerFeeFraction * 2 * 10_000;

  // 3. Use provided borrow APR (or default to 6%)
  const borrowInterestAprPct = borrowAprPct;
  const borrowAprDec = borrowAprPct / 100;

  // Convert borrow APR to cost per hour
  const borrowCostPctPerHour = borrowAprDec / (365 * 24) * 100;

  // 4. Get current funding rate
  const pairState = await merkle.getPairState({ pairId: perpPair });
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const { currentFundingRate } = calcFundingInfo({
    pairInfo,
    pairState,
    timestampSec: nowSec,
  });
  const MERKLE_FUNDING_RATE_SCALE = 10 ** 8;
  const HOURS_IN_DAY = 24;
  const fundingRatePerDay = Number(currentFundingRate) / MERKLE_FUNDING_RATE_SCALE;
  const fundingPctPerHour = (fundingRatePerDay / HOURS_IN_DAY) * 100;

  // 5. Calculate costs
  // One-time trading costs (paid once to enter/exit)
  const tradingCostPct = (spotRoundTripBps + perpRoundTripBps + gasEstimateBps) / 100;

  // Recurring costs per hour (borrow interest)
  const recurringCostPctPerHour = borrowCostPctPerHour;

  // For long perp: negative funding = we receive payments (shorts pay longs)
  const fundingIncomePctPerHour = Math.abs(fundingPctPerHour);

  // Net income per hour = funding income - recurring costs
  const netIncomePctPerHour = fundingIncomePctPerHour - recurringCostPctPerHour;

  // 6. Calculate breakeven time
  const isProfitable = netIncomePctPerHour > 0;
  const hoursToBreakeven = isProfitable ? tradingCostPct / netIncomePctPerHour : undefined;
  const daysToBreakeven = hoursToBreakeven ? hoursToBreakeven / 24 : undefined;

  return {
    isProfitable,
    hoursToBreakeven,
    daysToBreakeven,
    costs: {
      spotRoundTripBps,
      perpRoundTripBps,
      gasRoundTripBps: gasEstimateBps,
      tradingCostPct, // One-time cost
      borrowInterestAprPct,
      borrowCostPctPerHour: recurringCostPctPerHour, // Recurring cost per hour
    },
    funding: {
      currentFundingPctPerHour: fundingPctPerHour,
      fundingIncomePctPerHour, // What we receive (absolute value)
      netIncomePctPerHour, // Funding income - borrow cost
    },
  };
}

// ============================================================================
// CORE ARBITRAGE FUNCTION
// ============================================================================

export type ShortAptArbitrageParams = {
  account: Account;
  aptos: Aptos;
  merkle: MerkleClient;
  hyperionSdk: HyperionSDK;
  aptBorrowAmount: bigint;
  usdcTargetAmount: bigint;
  perpPair?: string;
  perpCollateralDelta?: bigint;
  slippageBps?: number;
  checkProfitability?: boolean;
  minNetFundingPctPerHour?: number;
  ariesConfig?: {
    coreAddress?: string;
    moduleName?: string;
    registerModuleName?: string;
    depositModuleName?: string;
    withdrawModuleName?: string;
    profileName?: string;
    collateralType?: string;
    wrappedCollateralType?: string;
    collateralAmount?: string;
    collateralKind?: 'coin' | 'fa';
    borrowType?: string;
    borrowKind?: 'coin' | 'fa';
    skipRegistration?: boolean;
    skipDeposit?: boolean;
    waitForSuccess?: boolean;
  };
};

export type ShortAptArbitrageResult = {
  borrowTxHash?: string;
  swapTxHash: string;
  perpTxHash: string;
  aptBorrowed: bigint;
  usdcReceived: bigint;
  perpSizeDelta: bigint;
  perpCollateralDelta: bigint;
};

/**
 * Executes a short APT arbitrage strategy:
 * 1. Analyzes profitability (optional check)
 * 2. Borrows APT from Aries
 * 3. Sells APT for USDC on Hyperion
 * 4. Opens long APT perp position on Merkle
 */
export async function executeShortAptArbitrage(
  params: ShortAptArbitrageParams
): Promise<ShortAptArbitrageResult> {
  const {
    account,
    aptos,
    merkle,
    hyperionSdk,
    aptBorrowAmount,
    usdcTargetAmount,
    perpPair = 'BTC_USD',
    perpCollateralDelta,
    slippageBps = 50,
    ariesConfig,
    checkProfitability = true,
    minNetFundingPctPerHour = 0.001,
  } = params;

  // Step 0: Check profitability if requested
  if (checkProfitability) {
    console.log('\n[0/3] Analyzing profitability...');
    const analysis = await analyzeShortAptProfitability({
      aptos,
      merkle,
      hyperionSdk,
      aptBorrowAmount,
      usdcTargetAmount,
      perpPair,
      borrowAprPct: 6, // Default 6% APR for APT borrowing
    });

    console.log('\n--- Profitability Analysis ---');
    console.log('One-time costs:');
    console.log(`  Spot round-trip: ${analysis.costs.spotRoundTripBps.toFixed(2)} bps`);
    console.log(`  Perp round-trip: ${analysis.costs.perpRoundTripBps.toFixed(2)} bps`);
    console.log(`  Gas estimate: ${analysis.costs.gasRoundTripBps.toFixed(2)} bps`);
    console.log(`  Total trading cost: ${analysis.costs.tradingCostPct.toFixed(4)}%`);
    console.log('\nRecurring costs:');
    console.log(`  Borrow APR: ${analysis.costs.borrowInterestAprPct.toFixed(2)}%`);
    console.log(`  Borrow cost/hr: ${analysis.costs.borrowCostPctPerHour.toFixed(6)}%/hr`);
    console.log('\nIncome:');
    console.log(`  Funding rate: ${analysis.funding.currentFundingPctPerHour.toFixed(6)}%/hr`);
    console.log(`  Funding income/hr: ${analysis.funding.fundingIncomePctPerHour.toFixed(6)}%/hr`);
    console.log(`  Net income/hr (after borrow): ${analysis.funding.netIncomePctPerHour.toFixed(6)}%/hr`);

    if (analysis.isProfitable && analysis.hoursToBreakeven) {
      console.log(
        `\n✓ PROFITABLE - Breakeven in ${analysis.hoursToBreakeven.toFixed(2)} hours (${analysis.daysToBreakeven?.toFixed(2)} days)`
      );
    } else {
      console.warn('\n✗ NOT PROFITABLE - Net income is negative or insufficient');
      throw new Error(
        `Strategy not profitable: net income ${analysis.funding.netIncomePctPerHour.toFixed(6)}%/hr < ${minNetFundingPctPerHour}%/hr`
      );
    }

    if (analysis.funding.netIncomePctPerHour < minNetFundingPctPerHour) {
      throw new Error(
        `Net income ${analysis.funding.netIncomePctPerHour.toFixed(6)}%/hr below minimum threshold ${minNetFundingPctPerHour}%/hr`
      );
    }
  }

  const APT_FA = '0xa';
  const USDC_FA = '0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b';
  const APT_TYPE_TAG = '0x1::aptos_coin::AptosCoin';
  const WRAPPED_USDC_TYPE = '0x9770fa9c725cbd97eb50b2be5f7416efdfd1f1554beb0750d4dae4c64e860da3::wrapped_coins::WrappedUSDC';
  const DEFAULT_ARIES_CORE = '0x9770fa9c725cbd97eb50b2be5f7416efdfd1f1554beb0750d4dae4c64e860da3';

  // Step 1: Borrow APT from Aries
  console.log('\n[1/3] Borrowing APT from Aries...');
  const ariesResult = await borrowWithAries({
    aptos,
    account,
    coreAddress: ariesConfig?.coreAddress ?? DEFAULT_ARIES_CORE,
    moduleName: ariesConfig?.moduleName ?? 'controller',
    registerModuleName: ariesConfig?.registerModuleName,
    depositModuleName: ariesConfig?.depositModuleName,
    withdrawModuleName: ariesConfig?.withdrawModuleName,
    profileName: ariesConfig?.profileName ?? 'main',
    collateralType: ariesConfig?.wrappedCollateralType ?? WRAPPED_USDC_TYPE,
    collateralAmount: ariesConfig?.collateralAmount ?? '0',
    wrappedCollateralType: ariesConfig?.wrappedCollateralType ?? WRAPPED_USDC_TYPE,
    collateralKind: ariesConfig?.collateralKind ?? 'fa',
    borrowType: ariesConfig?.borrowType ?? APT_TYPE_TAG,
    borrowAmount: aptBorrowAmount.toString(),
    borrowKind: ariesConfig?.borrowKind ?? 'coin',
    skipRegistration: ariesConfig?.skipRegistration ?? false,
    skipDeposit: ariesConfig?.skipDeposit ?? false,
    repayOnly: false,
    allowBorrow: true,
    waitForSuccess: ariesConfig?.waitForSuccess ?? true,
  });
  console.log('✓ APT borrowed, tx:', ariesResult.borrowTxHash);

  // Step 2: Get quote and swap APT -> USDC on Hyperion
  console.log('\n[2/3] Swapping APT -> USDC on Hyperion...');
  const quote = await hyperionSdk.Swap.estToAmount({
    from: APT_FA,
    to: USDC_FA,
    amount: usdcTargetAmount.toString(),
    safeMode: false,
  });

  const bestRoute = (quote as any)?.bestRoute ?? quote;
  if (!bestRoute?.path || bestRoute.path.length === 0) {
    throw new Error('Hyperion returned no route for APT -> USDC swap');
  }

  const swapPayload = await hyperionSdk.Swap.swapTransactionPayload({
    currencyA: APT_FA,
    currencyB: USDC_FA,
    currencyAAmount: bestRoute.amountIn,
    currencyBAmount: bestRoute.amountOut,
    slippage: slippageBps / 100,
    poolRoute: bestRoute.path ?? [],
    recipient: account.accountAddress.toString(),
  });

  const swapTxn = await aptos.transaction.build.simple({
    sender: account.accountAddress,
    data: swapPayload,
  });
  const swapPending = await aptos.signAndSubmitTransaction({
    signer: account,
    transaction: swapTxn,
  });
  await aptos.waitForTransaction({
    transactionHash: swapPending.hash,
  });
  console.log('✓ APT swapped for USDC, tx:', swapPending.hash);

  // Step 3: Deposit USDC to Merkle (if needed)
  console.log('\n[3/4] Checking Merkle USDC balance...');
  const pairInfo = await merkle.getPairInfo({ pairId: perpPair });
  const minSize = pairInfo.minimumPositionSize as unknown as bigint;
  const minCollateral = pairInfo.minimumOrderCollateral as unknown as bigint;

  const usdcReceived = BigInt(bestRoute.amountOut);
  const sizeDelta = usdcReceived > minSize ? usdcReceived : minSize;

  // Default to 1x leverage (collateral = size) unless specified otherwise
  const collateralDelta = perpCollateralDelta ??
    (sizeDelta > minCollateral ? sizeDelta : minCollateral);

  const merkleBalance = await merkle.getUsdcBalance({ accountAddress: account.accountAddress });
  if (merkleBalance < collateralDelta) {
    const deficit = collateralDelta - merkleBalance;
    console.log(`Merkle USDC balance: ${Number(merkleBalance) / 1_000_000} USDC`);
    console.log(`Need to deposit: ${Number(deficit) / 1_000_000} USDC`);

    // Deposit USDC to Merkle vault using SDK
    const depositPayload = await merkle.payloads.depositUsdc({
      userAddress: account.accountAddress,
      amount: deficit,
    });

    const depositTxn = await aptos.transaction.build.simple({
      sender: account.accountAddress,
      data: depositPayload,
    });
    const depositPending = await aptos.signAndSubmitTransaction({
      signer: account,
      transaction: depositTxn,
    });
    await aptos.waitForTransaction({
      transactionHash: depositPending.hash,
    });
    console.log('✓ USDC deposited to Merkle, tx:', depositPending.hash);
  } else {
    console.log(`✓ Sufficient Merkle balance: ${Number(merkleBalance) / 1_000_000} USDC`);
  }

  // Step 4: Open long perp position on Merkle
  console.log('\n[4/4] Opening long perp position on Merkle...');
  const perpPayload = await merkle.payloads.placeMarketOrder({
    pair: perpPair,
    userAddress: account.accountAddress,
    sizeDelta,
    collateralDelta,
    isLong: true,
    isIncrease: true,
  });

  const perpTxn = await aptos.transaction.build.simple({
    sender: account.accountAddress,
    data: perpPayload,
  });
  const perpPending = await aptos.signAndSubmitTransaction({
    signer: account,
    transaction: perpTxn,
  });
  await aptos.waitForTransaction({
    transactionHash: perpPending.hash,
  });
  console.log('✓ Long perp position opened, tx:', perpPending.hash);

  console.log('\n✅ Short APT arbitrage complete!');
  return {
    borrowTxHash: ariesResult.borrowTxHash,
    swapTxHash: swapPending.hash,
    perpTxHash: perpPending.hash,
    aptBorrowed: aptBorrowAmount,
    usdcReceived,
    perpSizeDelta: sizeDelta,
    perpCollateralDelta: collateralDelta,
  };
}

// ============================================================================
// CLI SCRIPT (uses the core function above)
// ============================================================================

type Args = {
  spotFromFa?: string;
  spotToFa?: string;
  spotInDecimals?: number;
  spotOut?: string;
  spotOutDecimals?: number;
  slippageBps?: number;
  hyperionNetwork?: string;
  safeMode?: boolean;
  perpPair?: string;
  perpCollateral?: string;
  submitSpot?: boolean;
  submitPerp?: boolean;
  minFundingRate?: string;
  perpNetwork?: string;
  spotRoundTripBps?: number;
  perpRoundTripBps?: number;
  gasRoundTripBps?: number;
  capitalAprPct?: number;
  holdHours?: number;
  fundingStdPctPerHr?: number;
  zScore?: number;
  basisPremiumPctPerHr?: number;
  ariesCoreAddress?: string;
  ariesModuleName?: string;
  ariesRegisterModuleName?: string;
  ariesDepositModuleName?: string;
  ariesWithdrawModuleName?: string;
  ariesProfile?: string;
  ariesCollateralType?: string;
  ariesWrappedCollateralType?: string;
  ariesCollateralAmount?: string;
  ariesCollateralUsdc?: string;
  ariesCollateralKind?: string;
  ariesBorrowType?: string;
  ariesBorrowKind?: string;
  ariesSkipRegistration?: string;
  ariesSkipDeposit?: string;
  ariesAllowBorrow?: string;
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

const USDC_FA_TYPE = '0xf22bede237a07e121b56d91a491eb7bcdfd1f5907926a9e58338f964a01b17fa::asset::USDC';
const WRAPPED_USDC_TYPE = '0x9770fa9c725cbd97eb50b2be5f7416efdfd1f1554beb0750d4dae4c64e860da3::wrapped_coins::WrappedUSDC';
const APT_TYPE_TAG = '0x1::aptos_coin::AptosCoin';
const USDC_DECIMALS = 6;
const APT_DECIMALS = 8;
const MERKLE_FUNDING_RATE_SCALE = 10 ** 8;
const HOURS_IN_DAY = 24;

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
      case 'spot-in-decimals':
        result.spotInDecimals = Number(next);
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
      case 'perp-collateral':
        result.perpCollateral = next;
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
      case 'min-funding':
        result.minFundingRate = next;
        i += 1;
        break;
      case 'perp-network':
        result.perpNetwork = next;
        i += 1;
        break;
      case 'spot-round-trip-bps':
        result.spotRoundTripBps = Number(next);
        i += 1;
        break;
      case 'perp-round-trip-bps':
        result.perpRoundTripBps = Number(next);
        i += 1;
        break;
      case 'gas-round-trip-bps':
        result.gasRoundTripBps = Number(next);
        i += 1;
        break;
      case 'capital-apr-pct':
        result.capitalAprPct = Number(next);
        i += 1;
        break;
      case 'hold-hours':
        result.holdHours = Number(next);
        i += 1;
        break;
      case 'funding-std-pct-per-hr':
        result.fundingStdPctPerHr = Number(next);
        i += 1;
        break;
      case 'z-score':
        result.zScore = Number(next);
        i += 1;
        break;
      case 'basis-premium-pct-per-hr':
        result.basisPremiumPctPerHr = Number(next);
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
      case 'aries-register-module-name':
        result.ariesRegisterModuleName = next;
        i += 1;
        break;
      case 'aries-deposit-module-name':
        result.ariesDepositModuleName = next;
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
      case 'aries-collateral-type':
        result.ariesCollateralType = next;
        i += 1;
        break;
      case 'aries-wrapped-collateral-type':
        result.ariesWrappedCollateralType = next;
        i += 1;
        break;
      case 'aries-collateral-amount':
        result.ariesCollateralAmount = next;
        i += 1;
        break;
      case 'aries-collateral-usdc':
        result.ariesCollateralUsdc = next;
        i += 1;
        break;
      case 'aries-collateral-kind':
        result.ariesCollateralKind = next;
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
      case 'aries-skip-registration':
        result.ariesSkipRegistration = next;
        i += 1;
        break;
      case 'aries-skip-deposit':
        result.ariesSkipDeposit = next;
        i += 1;
        break;
      case 'aries-allow-borrow':
        result.ariesAllowBorrow = next;
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
  const globalRef = globalThis as unknown as { WebSocket?: typeof WebSocket };
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
  const spotInDecimals = args.spotInDecimals ?? APT_DECIMALS;
  const spotOutDecimals = args.spotOutDecimals ?? USDC_DECIMALS;
  const slippageBps = args.slippageBps ?? 50;
  const safeMode = args.safeMode ?? false;
  const perpPair = args.perpPair ?? 'BTC_USD';
  const submitSpot = args.submitSpot ?? false;
  const submitPerp = args.submitPerp ?? false;
  const perpNetwork = (args.perpNetwork ?? 'mainnet').toLowerCase();

  const spotOutHuman = args.spotOut ?? '100';
  const spotOutBaseUnits = toBaseUnits(spotOutHuman, spotOutDecimals, 'spot-out');

  ensureWebSocketGlobal();

  const sdk = initHyperionSDK({
    network:
      hyperionNetwork === 'testnet'
        ? AptosNetwork.TESTNET
        : AptosNetwork.MAINNET,
    APTOS_API_KEY: process.env.APTOS_API_KEY ?? '',
  });

  console.log('--- Hyperion Quote (APT -> USDC amount-out) ---');
  console.log('Network       :', hyperionNetwork);
  console.log('Output token  :', spotToFa);
  console.log('Output amount :', spotOutHuman);
  console.log('Input token   :', spotFromFa);
  console.log('Slippage (bps):', slippageBps);

  const quote = await sdk.Swap.estToAmount({
    from: spotFromFa,
    to: spotToFa,
    amount: spotOutBaseUnits.toString(),
    safeMode,
  });

  const bestRoute = (quote as any)?.bestRoute ?? quote;
  if (!bestRoute?.path || bestRoute.path.length === 0) {
    console.error('Hyperion returned no route. Raw response:');
    console.dir(quote, { depth: null });
    return;
  }

  const { amountIn, amountOut, path } = bestRoute;
  const amountInBase = BigInt(amountIn); // APT sold (8 decimals by default)
  const amountOutBase = BigInt(amountOut); // USDC received (6 decimals by default)
  console.log('Hyperion route path:', path);
  console.log('Amount in (base)  :', amountIn);
  console.log('Amount out (base) :', amountOut);

  const slippagePercent = slippageBps / 100;

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

  const pairInfo = await merkle.getPairInfo({ pairId: perpPair });
  const pairState = await merkle.getPairState({ pairId: perpPair });
  let autoSpotRoundTripBps: number | undefined;
  let autoPerpRoundTripBps: number | undefined;
  let spotRoundTripUsed: number | undefined;
  let perpRoundTripUsed: number | undefined;
  let gasRoundTripBpsUsed: number | undefined;
  let costInputs: MinFundingInputs | undefined;
  let costBreakdown: MinFundingBreakdown | undefined;

  const holdAnalysisArg = args.minFundingRate;
  let holdAnalysisMode: 'auto' | 'manual' | undefined;
  let manualFundingRatePct: number | undefined;
  if (typeof holdAnalysisArg === 'string') {
    if (holdAnalysisArg.toLowerCase() === 'auto') {
      holdAnalysisMode = 'auto';
    } else {
      const parsed = Number(holdAnalysisArg);
      if (Number.isFinite(parsed)) {
        holdAnalysisMode = 'manual';
        manualFundingRatePct = parsed;
      } else {
        console.warn(
          `Invalid --min-funding value '${holdAnalysisArg}'. Ignoring hold-duration request.`,
        );
      }
    }
  }

  if (holdAnalysisMode) {
    const userSpotRoundTripBps =
      typeof args.spotRoundTripBps === 'number' && Number.isFinite(args.spotRoundTripBps)
        ? args.spotRoundTripBps
        : undefined;
    const userPerpRoundTripBps =
      typeof args.perpRoundTripBps === 'number' && Number.isFinite(args.perpRoundTripBps)
        ? args.perpRoundTripBps
        : undefined;
    if (userSpotRoundTripBps === undefined && args.spotRoundTripBps !== undefined) {
      console.warn('[cost inputs] Ignoring invalid --spot-round-trip-bps value.');
    }
    if (userPerpRoundTripBps === undefined && args.perpRoundTripBps !== undefined) {
      console.warn('[cost inputs] Ignoring invalid --perp-round-trip-bps value.');
    }

    gasRoundTripBpsUsed =
      typeof args.gasRoundTripBps === 'number' && Number.isFinite(args.gasRoundTripBps)
        ? args.gasRoundTripBps
        : undefined;

    const shouldEstimateSpotCost =
      holdAnalysisMode === 'auto' || userSpotRoundTripBps === undefined;
    if (shouldEstimateSpotCost) {
      try {
        const closeQuote = await sdk.Swap.estToAmount({
          from: spotToFa,
          to: spotFromFa,
          amount: amountOutBase.toString(),
          safeMode,
        });

        const openUsdcReceived = amountOutBase;
        const closeUsdcSpent = BigInt(closeQuote?.amountIn ?? 0);
        const closeAptReceived = BigInt(closeQuote?.amountOut ?? 0);

        if (closeAptReceived !== amountInBase) {
          console.warn(
            'Close quote returned a different APT amount than requested; spot cost auto-estimate skipped.',
          );
        } else if (openUsdcReceived === 0n) {
          console.warn('Open quote reported zero USDC received; spot cost auto-estimate skipped.');
        } else {
          const usdcScale = 10 ** spotOutDecimals;
          const openUsdc = Number(openUsdcReceived) / usdcScale;
          const closeUsdc = Number(closeUsdcSpent) / usdcScale;
          if (!Number.isFinite(openUsdc) || !Number.isFinite(closeUsdc)) {
            console.warn('Spot cost conversion overflowed; auto-estimate skipped.');
          } else {
            const roundTripCostPct = openUsdc <= 0
              ? 0
              : ((closeUsdc - openUsdc) / openUsdc) * 100;
            const nonNegativePct = Math.max(roundTripCostPct, 0);
            autoSpotRoundTripBps = nonNegativePct * 100;
            console.log(
              `Estimated spot round-trip cost: ${autoSpotRoundTripBps.toFixed(2)} bps (Hyperion open/close)`,
            );
          }
        }
      } catch (error) {
        console.warn('Failed to auto-estimate spot round-trip cost:', (error as Error).message);
      }
    }

    const takerFeeFraction = Number(pairInfo.takerFee) / 1_000_000;
    autoPerpRoundTripBps = takerFeeFraction * 2 * 10_000;
    if (Number.isFinite(autoPerpRoundTripBps)) {
      console.log(
        `Estimated perp round-trip cost: ${autoPerpRoundTripBps.toFixed(2)} bps (from Merkle fees)`,
      );
    } else {
      autoPerpRoundTripBps = undefined;
      console.warn('Failed to auto-estimate perp round-trip cost from Merkle fees.');
    }

    spotRoundTripUsed = userSpotRoundTripBps ?? autoSpotRoundTripBps;
    perpRoundTripUsed = userPerpRoundTripBps ?? autoPerpRoundTripBps;

    costInputs = {
      spotRoundTripBps: spotRoundTripUsed,
      perpRoundTripBps: perpRoundTripUsed,
      gasRoundTripBps: gasRoundTripBpsUsed,
      capitalAprPct: args.capitalAprPct,
      holdHours: args.holdHours,
      fundingStdPctPerHr: args.fundingStdPctPerHr,
      zScore: args.zScore,
      extraBasisPremiumPctPerHr: args.basisPremiumPctPerHr,
    } satisfies MinFundingInputs;

    costBreakdown = computeMinFundingBreakdown(costInputs);

    console.log('\n[breakeven] Cost assumptions:');
    if (spotRoundTripUsed !== undefined) {
      const source = userSpotRoundTripBps !== undefined ? 'override' : 'auto';
      console.log(
        `  spot round-trip : ${spotRoundTripUsed.toFixed(2)} bps (${source})`,
      );
    } else {
      console.warn('  spot round-trip : (missing, treated as 0 bps)');
    }
    if (perpRoundTripUsed !== undefined) {
      const source = userPerpRoundTripBps !== undefined ? 'override' : 'auto';
      console.log(
        `  perp round-trip : ${perpRoundTripUsed.toFixed(2)} bps (${source})`,
      );
    } else {
      console.warn('  perp round-trip : (missing, treated as 0 bps)');
    }
    const gasSource = gasRoundTripBpsUsed !== undefined ? 'override' : 'default';
    console.log(
      `  gas round-trip  : ${(gasRoundTripBpsUsed ?? 0).toFixed(2)} bps (${gasSource})`,
    );
    console.log(
      `  trading cost/hr : ${costBreakdown.tradingCostPctPerHour.toFixed(6)} %/hr (assuming hold ${costBreakdown.normalizedInputs.holdHours}h)`,
    );
    console.log(
      `  capital carry   : ${costBreakdown.capitalCostPctPerHour.toFixed(6)} %/hr (APR ${costBreakdown.normalizedInputs.capitalAprPct.toFixed(2)}%)`,
    );
    console.log(
      `  breakeven/hr    : ${costBreakdown.breakevenPctPerHour.toFixed(6)} %/hr`,
    );
    if (costBreakdown.riskBufferPctPerHour !== 0) {
      console.log(
        `  risk buffer     : ${costBreakdown.riskBufferPctPerHour.toFixed(6)} %/hr (z ${costBreakdown.normalizedInputs.zScore.toFixed(2)} · σ ${costBreakdown.normalizedInputs.fundingStdPctPerHr.toFixed(4)}%/hr)`,
      );
    } else {
      console.log('  risk buffer     : 0.000000 %/hr');
    }
    if (costBreakdown.basisPremiumPctPerHour !== 0) {
      console.log(
        `  basis premium   : ${costBreakdown.basisPremiumPctPerHour.toFixed(6)} %/hr`,
      );
    } else {
      console.log('  basis premium   : 0.000000 %/hr');
    }
  }

  const minSize = pairInfo.minimumPositionSize as unknown as bigint;
  const minCollateral = pairInfo.minimumOrderCollateral as unknown as bigint;

  if (holdAnalysisMode) {
    // Use the better analysis function that includes borrow interest
    console.log('\n=== PROFITABILITY ANALYSIS ===');

    const analysis = await analyzeShortAptProfitability({
      aptos,
      merkle,
      hyperionSdk: sdk,
      aptBorrowAmount: amountInBase,
      usdcTargetAmount: amountOutBase,
      perpPair,
      borrowAprPct: args.capitalAprPct ?? 6, // Use capital APR as borrow APR
      holdHours: args.holdHours ?? 24,
      gasEstimateBps: args.gasRoundTripBps ?? 5,
    });

    console.log('One-time costs:');
    console.log(`  Spot round-trip: ${analysis.costs.spotRoundTripBps.toFixed(2)} bps`);
    console.log(`  Perp round-trip: ${analysis.costs.perpRoundTripBps.toFixed(2)} bps`);
    console.log(`  Gas estimate: ${analysis.costs.gasRoundTripBps.toFixed(2)} bps`);
    console.log(`  Total trading cost: ${analysis.costs.tradingCostPct.toFixed(4)}%`);

    console.log('\nRecurring costs:');
    console.log(`  Borrow APR: ${analysis.costs.borrowInterestAprPct.toFixed(2)}%`);
    console.log(`  Borrow cost/hr: ${analysis.costs.borrowCostPctPerHour.toFixed(6)}%/hr`);

    console.log('\nIncome:');
    console.log(`  Funding rate: ${analysis.funding.currentFundingPctPerHour.toFixed(6)}%/hr`);
    console.log(`  Funding income/hr: ${analysis.funding.fundingIncomePctPerHour.toFixed(6)}%/hr`);
    console.log(`  Net income/hr: ${analysis.funding.netIncomePctPerHour.toFixed(6)}%/hr`);

    console.log('\nProfitability:');
    console.log(`  Is profitable: ${analysis.isProfitable ? '✅ YES' : '❌ NO'}`);
    if (analysis.hoursToBreakeven) {
      console.log(`  Breakeven: ${analysis.hoursToBreakeven.toFixed(2)} hours (~${analysis.daysToBreakeven?.toFixed(2)} days)`);
    }

    if (!analysis.isProfitable) {
      console.warn('\n⚠️  Strategy not profitable, aborting.');
      return;
    }
  }

  const requiredUsdc = amountOutBase;
  const sizeDelta = requiredUsdc > minSize ? requiredUsdc : minSize;

  // Default to 1x leverage (collateral = size) unless specified otherwise
  const collateralInput = args.perpCollateral
    ? BigInt(Math.round(Number(args.perpCollateral) * 1_000_000))
    : sizeDelta;
  const collateralDelta = collateralInput > minCollateral
    ? collateralInput
    : minCollateral;

  console.log('\n--- Aries Borrow + Hyperion Swap (short APT) ---');
  console.log('Borrow amount (APT base) :', amountInBase.toString());
  console.log('USDC proceeds (base)     :', amountOutBase.toString());

  if (submitSpot) {
    await executeBorrowForShortLeg({
      args,
      account,
      aptos,
      borrowAmount: amountInBase,
    });

    const payload = await sdk.Swap.swapTransactionPayload({
      currencyA: spotFromFa,
      currencyB: spotToFa,
      currencyAAmount: amountIn,
      currencyBAmount: amountOut,
      slippage: slippagePercent,
      poolRoute: path ?? [],
      recipient: account.accountAddress.toString(),
    });

    await submitAptosTransaction({ aptos, account, payload, label: 'Hyperion APT->USDC swap' });
  } else {
    console.log('Spot leg dry run (pass --submit-spot true to execute borrow + swap).');
  }

  console.log('\n--- Merkle Long Perp Leg ---');
  console.log('Pair            :', perpPair);
  console.log('Size Delta (6d) :', sizeDelta.toString());
  console.log('Collateral (6d) :', collateralDelta.toString());

  if (!submitPerp) {
    console.log('Perp leg dry run (pass --submit-perp true to execute).');
    return;
  }

  // Check and deposit USDC to Merkle if needed
  const merkleBalance = await merkle.getUsdcBalance({ accountAddress: account.accountAddress });
  if (merkleBalance < collateralDelta) {
    const deficit = collateralDelta - merkleBalance;
    console.log(`\nMerkle USDC balance: ${Number(merkleBalance) / 1_000_000} USDC`);
    console.log(`Need to deposit: ${Number(deficit) / 1_000_000} USDC`);

    // Deposit USDC to Merkle vault using SDK
    const depositPayload = await merkle.payloads.depositUsdc({
      userAddress: account.accountAddress,
      amount: deficit,
    });

    const depositTxn = await aptos.transaction.build.simple({
      sender: account.accountAddress,
      data: depositPayload,
    });
    const depositPending = await aptos.signAndSubmitTransaction({
      signer: account,
      transaction: depositTxn,
    });
    await aptos.waitForTransaction({
      transactionHash: depositPending.hash,
    });
    console.log('✓ USDC deposited to Merkle, tx:', depositPending.hash);
  } else {
    console.log(`✓ Sufficient Merkle balance: ${Number(merkleBalance) / 1_000_000} USDC`);
  }

  const payload = await merkle.payloads.placeMarketOrder({
    pair: perpPair,
    userAddress: account.accountAddress,
    sizeDelta,
    collateralDelta,
    isLong: true,
    isIncrease: true,
  });

  const rawTxn = await aptos.transaction.build.simple({
    sender: account.accountAddress,
    data: payload,
  });

  const pending = await aptos.signAndSubmitTransaction({
    signer: account,
    transaction: rawTxn,
  });
  console.log('Perp pending hash:', pending.hash);
  const committed = await aptos.waitForTransaction({ transactionHash: pending.hash });
  console.log('Perp confirmed at version:', committed.version);
}

main().catch((error) => {
  console.error('Arbitrage script error:', error);
  process.exitCode = 1;
});

type BorrowContext = {
  args: Args;
  account: Account;
  aptos: Aptos;
  borrowAmount: bigint;
};

async function executeBorrowForShortLeg(context: BorrowContext) {
  const { args, account, aptos, borrowAmount } = context;

  const coreAddress = args.ariesCoreAddress ?? process.env.ARIES_CORE_ADDRESS;
  if (!coreAddress) {
    throw new Error('Set ARIES_CORE_ADDRESS or pass --aries-core-address when submitting the spot leg.');
  }

  const moduleName = args.ariesModuleName ?? process.env.ARIES_MODULE_NAME ?? 'controller';
  const registerModule = args.ariesRegisterModuleName ?? process.env.ARIES_REGISTER_MODULE ?? moduleName;
  const depositModule = args.ariesDepositModuleName ?? process.env.ARIES_DEPOSIT_MODULE ?? moduleName;
  const withdrawModule = args.ariesWithdrawModuleName ?? process.env.ARIES_WITHDRAW_MODULE ?? moduleName;

  const profileName = args.ariesProfile ?? process.env.ARIES_PROFILE_NAME ?? 'main';

  const collateralTypeInput =
    args.ariesCollateralType ?? process.env.ARIES_COLLATERAL_TYPE ?? USDC_FA_TYPE;

  const collateralKind = inferKind(
    args.ariesCollateralKind ?? process.env.ARIES_COLLATERAL_KIND,
    collateralTypeInput,
    'fa',
  );

  const wrappedCollateralOverride =
    args.ariesWrappedCollateralType ?? process.env.ARIES_WRAPPED_COLLATERAL_TYPE;
  const wrappedCollateralType =
    wrappedCollateralOverride ?? resolveWrappedType(collateralTypeInput, collateralKind);
  if (collateralKind === 'fa' && !wrappedCollateralType) {
    throw new Error(
      `Unsupported FA collateral type '${collateralTypeInput}'. Provide --aries-wrapped-collateral-type or ARIES_WRAPPED_COLLATERAL_TYPE.`,
    );
  }

  const collateralAmount =
    args.ariesCollateralAmount
    ?? parseHumanAmount(
      args.ariesCollateralUsdc ?? process.env.ARIES_COLLATERAL_USDC,
      USDC_DECIMALS,
      'aries collateral',
    )
    ?? process.env.ARIES_COLLATERAL_AMOUNT
    ?? '0'; // Default to 0, which triggers auto-deposit of required amount

  const borrowType =
    args.ariesBorrowType ?? process.env.ARIES_BORROW_TYPE ?? APT_TYPE_TAG;
  const borrowKind = inferKind(
    args.ariesBorrowKind ?? process.env.ARIES_BORROW_KIND,
    borrowType,
    'coin',
  );

  const skipRegistration =
    parseBool(args.ariesSkipRegistration ?? process.env.ARIES_SKIP_REGISTRATION) ?? false;
  const skipDeposit =
    parseBool(args.ariesSkipDeposit ?? process.env.ARIES_SKIP_DEPOSIT) ?? false;
  const allowBorrow =
    parseBool(args.ariesAllowBorrow ?? process.env.ARIES_ALLOW_BORROW) ?? true;
  const waitForSuccess =
    parseBool(args.ariesWaitForSuccess ?? process.env.ARIES_WAIT_FOR_SUCCESS) ?? true;

  const borrowAmountString = borrowAmount.toString();
  const borrowAmountHuman = formatAssetAmount(borrowAmount, APT_DECIMALS, 'APT');

  console.log('\n[aries] Borrow request');
  console.log('  core address :', coreAddress);
  console.log('  module       :', moduleName);
  console.log('  profile      :', profileName);
  console.log('  collateral   :', wrappedCollateralType ?? collateralTypeInput);
  console.log('  borrow type  :', borrowType);
  console.log('  borrow amount:', borrowAmountHuman);

  await borrowWithAries({
    aptos,
    account,
    coreAddress,
    moduleName,
    registerModuleName: registerModule,
    depositModuleName: depositModule,
    withdrawModuleName: withdrawModule,
    profileName,
    collateralType: wrappedCollateralType ?? collateralTypeInput,
    collateralAmount,
    wrappedCollateralType,
    collateralKind,
    borrowType,
    borrowAmount: borrowAmountString,
    borrowKind,
    skipRegistration,
    skipDeposit,
    repayOnly: false,
    allowBorrow,
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

function parseBool(value: string | undefined): boolean | undefined {
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

function toBaseUnits(value: string, decimals: number, label: string): bigint {
  const parsed = parseHumanAmount(value, decimals, label);
  if (!parsed) return 0n;
  return BigInt(parsed);
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

function resolveWrappedType(typeTag: string, kind: 'coin' | 'fa'): string | undefined {
  if (kind !== 'fa') return undefined;
  if (typeTag === USDC_FA_TYPE || typeTag === '0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b::coin::T') {
    return WRAPPED_USDC_TYPE;
  }
  return undefined;
}

function formatAssetAmount(value: bigint, decimals: number, symbol: string): string {
  if (decimals === 0) return `${value.toString()} ${symbol}`;
  const divisor = Number(10n ** BigInt(decimals));
  const numeric = Number(value) / divisor;
  if (Number.isFinite(numeric)) {
    return `${numeric.toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: decimals,
    })} ${symbol}`;
  }
  return `${value.toString()} base units (${symbol})`;
}
