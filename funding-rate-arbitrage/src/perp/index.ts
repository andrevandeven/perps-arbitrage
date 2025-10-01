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

const PAIR_ID = 'APT_USD';
const DEFAULT_ORDER_SIZE_USDC = Number(process.env.ORDER_SIZE_USDC ?? '5');
const DEFAULT_ORDER_LEVERAGE = Number(process.env.ORDER_LEVERAGE ?? '20');
const DEFAULT_ORDER_DIRECTION: 'long' | 'short' =
  (process.env.ORDER_DIRECTION ?? 'long').toLowerCase() === 'short' ? 'short' : 'long';

type OrderOverrides = {
  sizeUSDC?: number;
  collateralUSDC?: number;
  leverage?: number;
  direction?: 'long' | 'short';
};

function parseOrderOverrides(argv: string[]): OrderOverrides {
  const result: OrderOverrides = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    const nextIsValue = next !== undefined && !next.startsWith('--');
    switch (key) {
      case 'size':
        if (nextIsValue) {
          result.sizeUSDC = Number(next);
          i += 1;
        }
        break;
      case 'collateral':
        if (nextIsValue) {
          result.collateralUSDC = Number(next);
          i += 1;
        }
        break;
      case 'leverage':
        if (nextIsValue) {
          result.leverage = Number(next);
          i += 1;
        }
        break;
      case 'direction':
        if (nextIsValue) {
          const dir = next.toLowerCase();
          if (dir === 'long' || dir === 'short') {
            result.direction = dir;
          }
          i += 1;
        }
        break;
      default:
        break;
    }
  }
  return result;
}

function ensureWebSocketGlobal() {
  const globalRef = globalThis as { WebSocket?: typeof WebSocket };
  if (!globalRef.WebSocket) {
    globalRef.WebSocket = WebSocket as unknown as typeof WebSocket;
  }
}

function formatFundingRate(rate: bigint) {
  const decimals = 10n ** 8n; // funding rate precision
  const rateAsNumber = Number(rate) / Number(decimals);
  return `${(rateAsNumber * 100).toFixed(4)}%`;
}

function formatUsdc(amount: bigint) {
  return (Number(amount) / 1_000_000).toFixed(6);
}

async function bootstrapClients() {
  ensureWebSocketGlobal();

  const privateKeyHex = process.env.PRIVATE_KEY?.trim();
  if (!privateKeyHex) {
    throw new Error('Set PRIVATE_KEY in your environment (copy .env.example)');
  }

  const privateKey = new Ed25519PrivateKey(privateKeyHex);
  const account = Account.fromPrivateKey({ privateKey });

  const merkle = new MerkleClient(await MerkleClientConfig.mainnet());
  const aptos = new Aptos(merkle.config.aptosConfig);

  return { merkle, aptos, account };
}

async function placeMarketOrder(args: {
  merkle: MerkleClient;
  aptos: Aptos;
  account: ReturnType<typeof Account.fromPrivateKey>;
  pairId: string;
  sizeDelta: bigint;
  collateralDelta: bigint;
  isLong: boolean;
}) {
  const { merkle, aptos, account, pairId, sizeDelta, collateralDelta, isLong } = args;

  console.log(
    `Building market order payload (size=${formatUsdc(sizeDelta)} USDC, collateral=${formatUsdc(collateralDelta)} USDC)...`,
  );
  const payload = await merkle.payloads.placeMarketOrder({
    pair: pairId,
    userAddress: account.accountAddress,
    sizeDelta,
    collateralDelta,
    isLong,
    isIncrease: true,
  });

  const rawTxn = await aptos.transaction.build.simple({
    sender: account.accountAddress,
    data: payload,
  });

  console.log('Submitting transaction to Aptos...');
  const pending = await aptos.signAndSubmitTransaction({
    signer: account,
    transaction: rawTxn,
  });

  console.log('Pending transaction hash:', pending.hash);
  const committed = await aptos.waitForTransaction({ transactionHash: pending.hash });
  console.log('Order committed at version:', committed.version);
}

async function main() {
  const { merkle, aptos, account } = await bootstrapClients();

  console.log('Initialized Merkle + Aptos clients');
  console.log('Account address:', account.accountAddress.toString());

  const overrides = parseOrderOverrides(process.argv.slice(2));

  let requestedSizeUSDC = overrides.sizeUSDC ?? DEFAULT_ORDER_SIZE_USDC;
  if (!Number.isFinite(requestedSizeUSDC) || requestedSizeUSDC <= 0) {
    throw new Error('Invalid order size specified.');
  }

  const leverageSpecified = overrides.leverage !== undefined;
  let targetLeverage = overrides.leverage ?? DEFAULT_ORDER_LEVERAGE;
  if (!Number.isFinite(targetLeverage) || targetLeverage <= 0) {
    throw new Error('Invalid leverage specified.');
  }

  const collateralSpecified = overrides.collateralUSDC !== undefined;
  let collateralUSDC = overrides.collateralUSDC ?? requestedSizeUSDC / targetLeverage;
  if (!Number.isFinite(collateralUSDC) || collateralUSDC <= 0) {
    throw new Error('Invalid collateral specified.');
  }

  let direction: 'long' | 'short' = overrides.direction ?? DEFAULT_ORDER_DIRECTION;
  console.log('Requested order params:', {
    sizeUSDC: requestedSizeUSDC,
    leverage: leverageSpecified ? targetLeverage : undefined,
    collateralUSDC: collateralSpecified ? collateralUSDC : undefined,
    direction,
  });

  let usdcBalance = await merkle.getUsdcBalance({ accountAddress: account.accountAddress });
  console.log('Current USDC balance:', `${formatUsdc(usdcBalance)} USDC`);

  // REST example: fetch summary + pair info
  const summary = await merkle.getSummary();
  const visiblePairs = summary.pairs.filter((pair) => pair.visible !== false);
  console.log(
    'Visible pairs:',
    visiblePairs.slice(0, 5).map((pair) => pair.id),
  );

  const pairInfo = await merkle.getPairInfo({ pairId: PAIR_ID });
  console.log(`${PAIR_ID} max leverage (raw bigint):`, pairInfo.maxLeverage.toString());
  console.log(
    `${PAIR_ID} min collateral (raw bigint):`,
    pairInfo.minimumOrderCollateral.toString(),
  );
  console.log(
    `${PAIR_ID} min position size (raw bigint):`,
    pairInfo.minimumPositionSize.toString(),
  );

  const pairState = await merkle.getPairState({ pairId: PAIR_ID });
  console.log(
    `${PAIR_ID} funding rate:`,
    formatFundingRate(pairState.fundingRate),
    `(${pairState.fundingRate.toString()} raw)`,
  );

  const minPositionSize = pairInfo.minimumPositionSize as unknown as bigint;
  const minOrderCollateral = pairInfo.minimumOrderCollateral as unknown as bigint;
  const maxLeverageRaw = pairInfo.maxLeverage as unknown as bigint;
  const minSizeUSDC = Number(minPositionSize) / 1_000_000;
  const minCollateralUSDC = Number(minOrderCollateral) / 1_000_000;
  const maxLeverage = Number(maxLeverageRaw) / 1_000_000;

  if (requestedSizeUSDC < minSizeUSDC) {
    console.warn(
      `Requested size ${requestedSizeUSDC.toFixed(6)} USDC is below protocol minimum of ${minSizeUSDC.toFixed(6)} USDC. Using minimum instead.`,
    );
    requestedSizeUSDC = minSizeUSDC;
    if (!collateralSpecified && leverageSpecified) {
      collateralUSDC = requestedSizeUSDC / targetLeverage;
    }
  }

  if (collateralUSDC < minCollateralUSDC) {
    console.warn(
      `Requested collateral ${collateralUSDC.toFixed(6)} USDC is below protocol minimum of ${minCollateralUSDC.toFixed(6)} USDC. Using minimum instead.`,
    );
    collateralUSDC = minCollateralUSDC;
  }

  let actualLeverage = requestedSizeUSDC / collateralUSDC;
  if (actualLeverage > maxLeverage) {
    const adjustedCollateral = Math.ceil((requestedSizeUSDC / maxLeverage) * 1_000_000) / 1_000_000;
    console.warn(
      `Requested leverage ${actualLeverage.toFixed(2)}x exceeds max ${maxLeverage.toFixed(2)}x. Increasing collateral to ${adjustedCollateral.toFixed(6)} USDC.`,
    );
    collateralUSDC = adjustedCollateral;
    actualLeverage = requestedSizeUSDC / collateralUSDC;
  }

  const sizeDelta = BigInt(Math.round(requestedSizeUSDC * 1_000_000));
  const collateralDelta = BigInt(Math.round(collateralUSDC * 1_000_000));

  actualLeverage = Number(sizeDelta) / Number(collateralDelta);

  console.log('Final order size (USDC):', formatUsdc(sizeDelta));
  console.log('Final collateral (USDC):', formatUsdc(collateralDelta));
  console.log('Implied leverage:', actualLeverage.toFixed(2), 'x');

  if (usdcBalance < collateralDelta) {
    console.warn(
      `Not enough USDC to place order. Needed ${formatUsdc(collateralDelta)} USDC,` +
        ` but have ${formatUsdc(usdcBalance)} USDC. Skipping trade.`,
    );
  } else {
    await placeMarketOrder({
      merkle,
      aptos,
      account,
      pairId: PAIR_ID,
      sizeDelta,
      collateralDelta,
      isLong: direction === 'long',
    });

    usdcBalance = await merkle.getUsdcBalance({ accountAddress: account.accountAddress });
    console.log('USDC balance after trade:', `${formatUsdc(usdcBalance)} USDC`);
  }

  // WebSocket example: consume a single price update
  const session = await merkle.connectWsApi();
  console.log('Connected to Merkle websocket');

  const iterator = session.subscribePriceFeed(PAIR_ID)[Symbol.asyncIterator]();
  const { value: priceUpdate } = await iterator.next();
  if (priceUpdate) {
    console.log('Live BTC_USD price update:', priceUpdate);
  } else {
    console.warn('Did not receive a price update before stream ended');
  }

  try {
    await iterator.return?.();
  } catch (error) {
    console.warn('Price feed stream already closed:', (error as Error).message);
  }
  session.disconnect();

  // Ensure Aptos client is usable for signing/queries
  console.log('Aptos client chain ID:', await aptos.getChainId());
  console.log('Bootstrap complete.');
}

main().catch((error) => {
  console.error('Bootstrap error:', error);
  process.exitCode = 1;
});
