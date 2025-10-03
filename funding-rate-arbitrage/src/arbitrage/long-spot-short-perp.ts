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
  calcFundingInfo,
} from '@merkletrade/ts-sdk';
import {
  computeMinFundingBreakdown,
  computeBreakevenHoldDuration,
  type MinFundingInputs,
  type MinFundingBreakdown,
} from '../utils/minFunding';

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
  const spotFromFa = normalizeFa(args.spotFromFa ?? defaultMap.usdc);
  const spotToFa = normalizeFa(args.spotToFa ?? defaultMap.apt);
  const spotInDecimals = args.spotInDecimals ?? 6;
  const spotOutHuman = args.spotOut ?? '0.001';
  const spotOutDecimals = args.spotOutDecimals ?? 8;
  const slippageBps = args.slippageBps ?? 50;
  const safeMode = args.safeMode ?? false;
  const perpPair = args.perpPair ?? 'APT_USD';
  const submitSpot = args.submitSpot ?? false;
  const submitPerp = args.submitPerp ?? false;
  const perpNetwork = (args.perpNetwork ?? 'mainnet').toLowerCase();

  const minFundingArg = args.minFundingRate;
  let holdAnalysisMode: 'auto' | 'manual' | undefined;
  let manualFundingRatePct: number | undefined;
  if (typeof minFundingArg === 'string') {
    if (minFundingArg.toLowerCase() === 'auto') {
      holdAnalysisMode = 'auto';
    } else {
      const parsed = Number(minFundingArg);
      if (Number.isFinite(parsed)) {
        holdAnalysisMode = 'manual';
        manualFundingRatePct = parsed;
      } else {
        console.warn(
          `Invalid --min-funding value '${minFundingArg}'. Ignoring hold-duration request.`,
        );
      }
    }
  }

  ensureWebSocketGlobal();

  const sdk = initHyperionSDK({
    network:
      hyperionNetwork === 'testnet'
        ? AptosNetwork.TESTNET
        : AptosNetwork.MAINNET,
    APTOS_API_KEY: process.env.APTOS_API_KEY ?? '',
  });

  const spotOutBaseUnits = BigInt(
    Math.round(Number(spotOutHuman) * 10 ** spotOutDecimals),
  );

  const quote = await sdk.Swap.estToAmount({
    from: spotFromFa,
    to: spotToFa,
    amount: spotOutBaseUnits.toString(),
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

  const { amountIn, amountOut, path } = bestRoute;
  const amountInBase = BigInt(amountIn);
  const amountOutBase = BigInt(amountOut);

  const hyperionQuote = {
    network: hyperionNetwork,
    outputToken: spotToFa,
    outputAmount: spotOutHuman,
    inputToken: spotFromFa,
    slippageBps: slippageBps,
    routePath: path,
    amountIn: amountIn,
    amountOut: amountOut,
    amountInBase: amountInBase.toString(),
    amountOutBase: amountOutBase.toString()
  };

  const slippagePercent = slippageBps / 100;

  if (submitSpot) {
    const payload = await sdk.Swap.swapTransactionPayload({
      currencyA: spotFromFa,
      currencyB: spotToFa,
      currencyAAmount: amountIn,
      currencyBAmount: amountOut,
      slippage: slippagePercent,
      poolRoute: path ?? [],
      recipient: process.env.HYPERION_RECIPIENT ?? '',
    });

    const spotExecution = {
      action: 'spot_swap_payload_generated',
      payload: payload,
      message: 'Submit via Aptos SDK to execute spot leg.'
    };
    console.log(JSON.stringify(spotExecution, null, 2));
  }

  const requiredUsdc = amountInBase;

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

  const pairInfo = await merkle.getPairInfo({ pairId: perpPair });
  const pairState = await merkle.getPairState({ pairId: perpPair });
  let autoSpotRoundTripBps: number | undefined;
  let autoPerpRoundTripBps: number | undefined;
  let spotRoundTripUsed: number | undefined;
  let perpRoundTripUsed: number | undefined;
  let gasRoundTripBpsUsed: number | undefined;
  let costInputs: MinFundingInputs | undefined;
  let costBreakdown: MinFundingBreakdown | undefined;
  let costAnalysis: any = null;
  let fundingAnalysis: any = null;

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

        const openUsdcSpent = amountInBase;
        const closeUsdcReceived = BigInt(closeQuote?.amountOut ?? 0);
        const closeAptRequired = BigInt(closeQuote?.amountIn ?? 0);

        if (closeAptRequired !== amountOutBase) {
          console.warn(
            'Close quote returned a different APT amount than requested; spot cost auto-estimate skipped.',
          );
        } else if (openUsdcSpent === 0n) {
          console.warn('Open quote reported zero USDC spent; spot cost auto-estimate skipped.');
        } else {
          const usdcScale = 10 ** spotInDecimals;
          const openUsdc = Number(openUsdcSpent) / usdcScale;
          const closeUsdc = Number(closeUsdcReceived) / usdcScale;
          if (!Number.isFinite(openUsdc) || !Number.isFinite(closeUsdc)) {
            console.warn('Spot cost conversion overflowed; auto-estimate skipped.');
          } else {
            const roundTripCostPct = openUsdc <= 0
              ? 0
              : ((openUsdc - closeUsdc) / openUsdc) * 100;
            const nonNegativePct = Math.max(roundTripCostPct, 0);
            autoSpotRoundTripBps = nonNegativePct * 100;
            // Store for later JSON output
          }
        }
      } catch (error) {
        console.warn('Failed to auto-estimate spot round-trip cost:', (error as Error).message);
      }
    }

    const takerFeeFraction = Number(pairInfo.takerFee) / 1_000_000;
    autoPerpRoundTripBps = takerFeeFraction * 2 * 10_000;
    if (Number.isFinite(autoPerpRoundTripBps)) {
      // Store for later JSON output
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

    costAnalysis = {
      spotRoundTrip: {
        value: spotRoundTripUsed,
        source: userSpotRoundTripBps !== undefined ? 'override' : 'auto',
        unit: 'bps'
      },
      perpRoundTrip: {
        value: perpRoundTripUsed,
        source: userPerpRoundTripBps !== undefined ? 'override' : 'auto',
        unit: 'bps'
      },
      gasRoundTrip: {
        value: gasRoundTripBpsUsed ?? 0,
        source: gasRoundTripBpsUsed !== undefined ? 'override' : 'default',
        unit: 'bps'
      },
      tradingCostPerHour: {
        value: costBreakdown.tradingCostPctPerHour,
        unit: '%/hr',
        holdHours: costBreakdown.normalizedInputs.holdHours
      },
      capitalCostPerHour: {
        value: costBreakdown.capitalCostPctPerHour,
        unit: '%/hr',
        apr: costBreakdown.normalizedInputs.capitalAprPct
      },
      breakevenPerHour: {
        value: costBreakdown.breakevenPctPerHour,
        unit: '%/hr'
      },
      riskBufferPerHour: {
        value: costBreakdown.riskBufferPctPerHour,
        unit: '%/hr',
        zScore: costBreakdown.normalizedInputs.zScore,
        fundingStd: costBreakdown.normalizedInputs.fundingStdPctPerHr
      },
      basisPremiumPerHour: {
        value: costBreakdown.basisPremiumPctPerHour,
        unit: '%/hr'
      }
    };
  }

  const minSize = pairInfo.minimumPositionSize as unknown as bigint;
  const minCollateral = pairInfo.minimumOrderCollateral as unknown as bigint;

  if (holdAnalysisMode) {
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const { currentFundingRate } = calcFundingInfo({
      pairInfo,
      pairState,
      timestampSec: nowSec,
    });
    const fundingRatePerDay = Number(currentFundingRate) /
      MERKLE_FUNDING_RATE_SCALE;
    const fundingPctPerHourActual = (fundingRatePerDay / HOURS_IN_DAY) * 100;

    const fundingForHold = holdAnalysisMode === 'auto'
      ? fundingPctPerHourActual
      : manualFundingRatePct ?? fundingPctPerHourActual;

    const breakeven = computeBreakevenHoldDuration(costInputs ?? {}, fundingForHold);

    const tradingCostPct = breakeven.tradingCostPct;
    const netFundingPerHour = breakeven.netFundingPerHour;

    fundingAnalysis = {
      currentFundingRate: {
        value: fundingPctPerHourActual,
        unit: '%/hr',
        source: 'pair_state'
      },
      fundingForHold: {
        value: fundingForHold,
        unit: '%/hr',
        mode: holdAnalysisMode,
        manualInput: manualFundingRatePct
      },
      breakeven: {
        possible: breakeven.breakevenPossible,
        holdHours: breakeven.holdHours,
        holdDays: breakeven.holdDays,
        tradingCostPct: tradingCostPct,
        netFundingPerHour: netFundingPerHour
      }
    };

    if (!breakeven.breakevenPossible || netFundingPerHour <= 0) {
      const abortResult = {
        action: 'abort',
        reason: 'insufficient_funding',
        fundingRate: fundingForHold,
        tradingCost: tradingCostPct,
        netFunding: netFundingPerHour,
        analysis: fundingAnalysis
      };
      console.log(JSON.stringify(abortResult, null, 2));
      return;
    }
  }

  const sizeDelta = requiredUsdc > minSize ? requiredUsdc : minSize;

  // Default to 1x leverage (collateral = size) unless specified otherwise
  const collateralInput = args.perpCollateral
    ? BigInt(Math.round(Number(args.perpCollateral) * 1_000_000))
    : sizeDelta;
  const collateralDelta = collateralInput > minCollateral
    ? collateralInput
    : minCollateral;

  const perpLeg = {
    pair: perpPair,
    sizeDelta: sizeDelta.toString(),
    collateralDelta: collateralDelta.toString(),
    direction: 'SHORT',
    submitPerp: submitPerp
  };

  if (!submitPerp) {
    const dryRunResult = {
      action: 'dry_run',
      message: 'Perp leg dry run (pass --submit-perp true to execute).',
      perpLeg: perpLeg,
      hyperionQuote: hyperionQuote,
      costAnalysis: costAnalysis,
      fundingAnalysis: fundingAnalysis
    };
    console.log(JSON.stringify(dryRunResult, null, 2));
    return;
  }

  // Check and deposit USDC to Merkle if needed
  const merkleBalance = await merkle.getUsdcBalance({ accountAddress: account.accountAddress });
  let depositResult = null;

  if (merkleBalance < collateralDelta) {
    const deficit = collateralDelta - merkleBalance;

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

    depositResult = {
      action: 'usdc_deposited',
      deficit: deficit.toString(),
      transactionHash: depositPending.hash,
      merkleBalanceBefore: merkleBalance.toString()
    };
  }

  const payload = await merkle.payloads.placeMarketOrder({
    pair: perpPair,
    userAddress: account.accountAddress,
    sizeDelta,
    collateralDelta,
    isLong: false,
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
  const committed = await aptos.waitForTransaction({ transactionHash: pending.hash });

  const executionResult = {
    action: 'arbitrage_executed',
    strategy: 'long_spot_short_perp',
    hyperionQuote: hyperionQuote,
    perpLeg: perpLeg,
    costAnalysis: costAnalysis,
    fundingAnalysis: fundingAnalysis,
    depositResult: depositResult,
    perpTransaction: {
      hash: pending.hash,
      version: committed.version,
      pair: perpPair,
      sizeDelta: sizeDelta.toString(),
      collateralDelta: collateralDelta.toString()
    }
  };

  console.log(JSON.stringify(executionResult, null, 2));
}

main().catch((error) => {
  console.error('Arbitrage script error:', error);
  process.exitCode = 1;
});
