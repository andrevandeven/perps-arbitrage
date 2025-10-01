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
  const globalRef = globalThis as { WebSocket?: typeof WebSocket };
  if (!globalRef.WebSocket) {
    globalRef.WebSocket = WebSocket as unknown as typeof WebSocket;
  }
}

async function main() {
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
  const perpPair = args.perpPair ?? 'BTC_USD';
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

  console.log('--- Hyperion Quote (amount-out mode) ---');
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
  const amountInBase = BigInt(amountIn);
  const amountOutBase = BigInt(amountOut);
  console.log('Hyperion route path:', path);
  console.log('Amount in (base)  :', amountIn);
  console.log('Amount out (base) :', amountOut);

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
    console.log('Spot payload:', payload);
    console.log('Submit via Aptos SDK to execute spot leg.');
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
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const { currentFundingRate } = calcFundingInfo({
      pairInfo,
      pairState,
      timestampSec: nowSec,
    });
    const fundingRatePerDay = Number(currentFundingRate) /
      MERKLE_FUNDING_RATE_SCALE;
    const fundingPctPerHourActual = (fundingRatePerDay / HOURS_IN_DAY) * 100;

    console.log(
      `\n[breakeven] Current funding approx: ${fundingPctPerHourActual.toFixed(6)} %/hr (pair state)`,
    );

    const fundingForHold = holdAnalysisMode === 'auto'
      ? fundingPctPerHourActual
      : manualFundingRatePct ?? fundingPctPerHourActual;

    if (holdAnalysisMode === 'manual' && manualFundingRatePct !== undefined) {
      console.log(
        `[breakeven] Manual funding input : ${manualFundingRatePct.toFixed(6)} %/hr`,
      );
    }

    const breakeven = computeBreakevenHoldDuration(costInputs ?? {}, fundingForHold);

    const tradingCostPct = breakeven.tradingCostPct;
    const netFundingPerHour = breakeven.netFundingPerHour;

    if (!breakeven.breakevenPossible || netFundingPerHour <= 0) {
      console.warn(
        `[breakeven] Funding ${fundingForHold.toFixed(6)} %/hr cannot cover ${tradingCostPct.toFixed(4)}% trading + carry costs. Aborting.`,
      );
      return;
    }

    const holdHours = breakeven.holdHours ?? 0;
    const holdDays = breakeven.holdDays ?? holdHours / 24;
    console.log(
      `[breakeven] Required hold: ${holdHours.toFixed(2)} hours (~${holdDays.toFixed(2)} days) to recover ${tradingCostPct.toFixed(4)}% round-trip cost. Net funding after carry: ${netFundingPerHour.toFixed(6)} %/hr`,
    );
  }

  const sizeDelta = requiredUsdc > minSize ? requiredUsdc : minSize;
  const collateralInput = args.perpCollateral
    ? BigInt(Math.round(Number(args.perpCollateral) * 1_000_000))
    : sizeDelta / 10n;
  const collateralDelta = collateralInput > minCollateral
    ? collateralInput
    : minCollateral;

  console.log('\n--- Merkle Short Leg ---');
  console.log('Pair            :', perpPair);
  console.log('Size Delta (6d) :', sizeDelta.toString());
  console.log('Collateral (6d):', collateralDelta.toString());

  if (!submitPerp) {
    console.log('Perp leg dry run (pass --submit-perp true to execute).');
    return;
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
  console.log('Perp pending hash:', pending.hash);
  const committed = await aptos.waitForTransaction({ transactionHash: pending.hash });
  console.log('Perp confirmed at version:', committed.version);
}

main().catch((error) => {
  console.error('Arbitrage script error:', error);
  process.exitCode = 1;
});
