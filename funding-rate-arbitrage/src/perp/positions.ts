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
  calcFundingFee,
  calcRolloverFee,
} from '@merkletrade/ts-sdk';

import {
  collateralToNumber,
  formatFunding,
  formatNumber,
  formatPrice,
  formatUsdc,
  parsePairId,
  priceToNumber,
} from './utils.js';

function ensureWebSocketGlobal() {
  const globalRef = globalThis as { WebSocket?: typeof WebSocket };
  if (!globalRef.WebSocket) {
    globalRef.WebSocket = WebSocket as unknown as typeof WebSocket;
  }
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

async function fetchPriceFromFeed(merkle: MerkleClient, pairId: string, timeoutMs = 5_000) {
  const session = await merkle.connectWsApi();
  let iterator: AsyncIterator<any> | undefined;
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('price feed timeout')), timeoutMs),
  );

  try {
    iterator = session.subscribePriceFeed(pairId)[Symbol.asyncIterator]();
    const { value } = await Promise.race([iterator.next(), timeout]);
    if (value?.price !== undefined) {
      return Number(value.price);
    }
  } catch (error) {
    console.warn(`Unable to fetch ${pairId} price:`, (error as Error).message);
  } finally {
    try {
      await iterator?.return?.();
    } catch (err) {
      // ignore controller already closed errors
    }
    session.disconnect();
  }

  return undefined;
}

async function fetchMarkPrices(merkle: MerkleClient, pairIds: string[]) {
  const prices = new Map<string, number>();
  for (const pairId of pairIds) {
    let price: number | undefined;
    for (let attempt = 0; attempt < 3 && price === undefined; attempt += 1) {
      price = await fetchPriceFromFeed(merkle, pairId, 7_000);
    }
    if (price === undefined) {
      throw new Error(`Failed to fetch live price for ${pairId}`);
    }
    prices.set(pairId, price);
  }
  return prices;
}

async function showStatus(merkle: MerkleClient, account: Account) {
  const [positions, orders, balance, summary] = await Promise.all([
    merkle.getPositions({ address: account.accountAddress }),
    merkle.getOrders({ address: account.accountAddress }),
    merkle.getUsdcBalance({ accountAddress: account.accountAddress }),
    merkle.getSummary(),
  ]);

  const pairStateCache = new Map<string, Awaited<ReturnType<typeof merkle.getPairState>>>();

  const loadPairState = async (pairId: string) => {
    if (!pairStateCache.has(pairId)) {
      pairStateCache.set(pairId, await merkle.getPairState({ pairId }));
    }
    return pairStateCache.get(pairId)!;
  };

  const pairIds = Array.from(
    new Set(positions.map((position) => parsePairId(position.pairType))),
  );

  const markPrices = await fetchMarkPrices(merkle, pairIds);

  console.log('Account:', account.accountAddress.toString());
  console.log('Free USDC balance:', formatUsdc(balance));

  if (positions.length === 0) {
    console.log('No open positions.');
  } else {
    console.log('Open positions:');
    for (const position of positions) {
      const pairId = parsePairId(position.pairType);
      const pairState = await loadPairState(pairId);
      const markPrice = markPrices.get(pairId);
      if (markPrice === undefined) {
        throw new Error(`Missing mark price for ${pairId}`);
      }
      const avgPrice = priceToNumber(position.avgPrice);
      const sizeUsdc = collateralToNumber(position.size);
      let pnl = (markPrice - avgPrice) / avgPrice * sizeUsdc;
      if (!position.isLong) {
        pnl = -pnl;
      }
      const fundingFee = collateralToNumber(
        calcFundingFee({
          position,
          currentAccFundingFeePerSize: pairState.accFundingFeePerSize,
        }),
      );
      const rolloverFee = collateralToNumber(
        calcRolloverFee({
          position,
          currentAccRolloverFeePerCollateral: pairState.accRolloverFeePerCollateral,
        }),
      );
      const netPnl = pnl - fundingFee - rolloverFee;

      console.log('---');
      console.log('Pair:', pairId);
      console.log('Direction:', position.isLong ? 'LONG' : 'SHORT');
      console.log('Size (USDC):', formatUsdc(position.size));
      console.log('Collateral (USDC):', formatUsdc(position.collateral));
      console.log('Average price:', formatPrice(position.avgPrice));
      console.log('Mark price:', formatNumber(markPrice, 4));
      console.log('Unrealized PnL (USDC):', formatNumber(pnl));
      console.log('Funding fee accrued (USDC):', formatNumber(fundingFee));
      console.log('Rollover fee accrued (USDC):', formatNumber(rolloverFee));
      console.log('Net PnL after fees (USDC):', formatNumber(netPnl));
      console.log('Last exec timestamp:', new Date(position.lastExecuteTimestamp * 1000).toISOString());
      console.log('Acc funding per size:', formatFunding(position.accFundingFeePerSize));
      console.log('Acc rollover per collateral:', formatFunding(position.accRolloverFeePerCollateral));
    }
  }

  if (orders.length === 0) {
    console.log('No resting orders.');
  } else {
    console.log('Open orders:');
    for (const order of orders) {
      console.log('---');
      console.log('Order ID:', order.orderId);
      console.log('Pair:', parsePairId(order.pairType));
      console.log('Market?', order.isMarket);
      console.log('Direction:', order.isLong ? 'LONG' : 'SHORT');
      console.log('Increase?', order.isIncrease);
      console.log('Size delta (USDC):', formatUsdc(order.sizeDelta));
      console.log('Collateral delta (USDC):', formatUsdc(order.collateralDelta));
      console.log('Price:', formatPrice(order.price));
      console.log('Created at:', new Date(order.createdTimestamp * 1000).toISOString());
    }
  }
}

async function closePosition(merkle: MerkleClient, aptos: Aptos, account: Account, pairId: string) {
  const positions = await merkle.getPositions({ address: account.accountAddress });
  const target = positions.find((pos) => parsePairId(pos.pairType) === pairId);
  if (!target || target.size === 0n) {
    console.log(`No open position found for ${pairId}.`);
    return;
  }

  console.log(`Closing ${pairId} position (size ${formatUsdc(target.size)} USDC)...`);
  const payload = await merkle.payloads.placeMarketOrder({
    pair: pairId,
    userAddress: account.accountAddress,
    sizeDelta: target.size,
    collateralDelta: 0n,
    isLong: target.isLong,
    isIncrease: false,
  });

  const rawTxn = await aptos.transaction.build.simple({
    sender: account.accountAddress,
    data: payload,
  });

  const pending = await aptos.signAndSubmitTransaction({ signer: account, transaction: rawTxn });
  console.log('Close transaction hash:', pending.hash);
  const committed = await aptos.waitForTransaction({ transactionHash: pending.hash });
  console.log('Close confirmed at version:', committed.version);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const pairArg = args[1]?.toUpperCase();

  const { merkle, aptos, account } = await bootstrapClients();

  if (command === 'close') {
    const pairId = pairArg ?? 'BTC_USD';
    await closePosition(merkle, aptos, account, pairId);
    await showStatus(merkle, account);
    return;
  }

  await showStatus(merkle, account);
}

main().catch((error) => {
  console.error('Positions error:', error);
  process.exitCode = 1;
});
