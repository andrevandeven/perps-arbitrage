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

const DEFAULT_ARIES_CORE_ADDRESS = '0x9770fa9c725cbd97eb50b2be5f7416efdfd1f1554beb0750d4dae4c64e860da3';
const DEFAULT_WRAPPED_USDC = `${DEFAULT_ARIES_CORE_ADDRESS}::wrapped_coins::WrappedUSDC`;
const ARIES_USDC_DECIMALS = 6;

/**
 * Get the current funding rate for a given pair
 * @param merkle - Merkle client instance
 * @param pairId - Trading pair ID (e.g., 'APT_USD')
 * @returns Funding rate as a decimal (e.g., 0.0001 for 0.01%)
 */
export async function getFundingRate(pairId: string = 'APT_USD'): Promise<number> {
  const merkle = new MerkleClient(await MerkleClientConfig.mainnet());
  const pairState = await merkle.getPairState({ pairId });
  return Number(pairState.fundingRate) / 1_000_000;
}


function ensureWebSocketGlobal() {
  const globalRef = globalThis as unknown as { WebSocket?: typeof WebSocket };
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
      if (iterator) {
        await iterator.return?.();
      }
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
  console.log('🔍 [DEBUG] showStatus: Getting positions and balance for account:', account.accountAddress.toString());

  const [positions, orders, balance, summary] = await Promise.all([
    merkle.getPositions({ address: account.accountAddress }),
    merkle.getOrders({ address: account.accountAddress }),
    merkle.getUsdcBalance({ accountAddress: account.accountAddress }),
    merkle.getSummary(),
  ]);

  console.log('📊 [DEBUG] showStatus: Raw balance from Merkle:', balance);
  console.log('📈 [DEBUG] showStatus: Positions count:', positions.length);
  console.log('📋 [DEBUG] showStatus: Orders count:', orders.length);

  const pairStateCache = new Map<string, Awaited<ReturnType<typeof merkle.getPairState>>>();

  const loadPairState = async (pairId: string) => {
    if (!pairStateCache.has(pairId)) {
      pairStateCache.set(pairId, await merkle.getPairState({ pairId }));
    }
    return pairStateCache.get(pairId)!;
  };

  const pairIds = Array.from(
    new Set(positions.map((position: any) => parsePairId(position.pairType))),
  );

  const markPrices = await fetchMarkPrices(merkle, pairIds as string[]);

  const statusData = {
    account: account.accountAddress.toString(),
    freeUsdcBalance: formatUsdc(balance),
    positions: [] as any[],
    orders: [] as any[]
  };

  console.log('💰 [DEBUG] showStatus: Formatted balance:', formatUsdc(balance));
  console.log('🏦 [DEBUG] showStatus: Account address:', account.accountAddress.toString());

  if (positions.length === 0) {
    statusData.positions = [];
  } else {
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

      statusData.positions.push({
        pair: pairId,
        direction: position.isLong ? 'LONG' : 'SHORT',
        sizeUsdc: formatUsdc(position.size),
        collateralUsdc: formatUsdc(position.collateral),
        averagePrice: formatPrice(position.avgPrice),
        markPrice: formatNumber(markPrice, 4),
        unrealizedPnlUsdc: formatNumber(pnl),
        fundingFeeAccruedUsdc: formatNumber(fundingFee),
        rolloverFeeAccruedUsdc: formatNumber(rolloverFee),
        netPnlAfterFeesUsdc: formatNumber(netPnl),
        lastExecTimestamp: new Date(position.lastExecuteTimestamp * 1000).toISOString(),
        accFundingPerSize: formatFunding(position.accFundingFeePerSize),
        accRolloverPerCollateral: formatFunding(position.accRolloverFeePerCollateral)
      });
    }
  }

  if (orders.length === 0) {
    statusData.orders = [];
  } else {
    for (const order of orders) {
      statusData.orders.push({
        orderId: order.orderId,
        pair: parsePairId(order.pairType),
        isMarket: order.isMarket,
        direction: order.isLong ? 'LONG' : 'SHORT',
        isIncrease: order.isIncrease,
        sizeDeltaUsdc: formatUsdc(order.sizeDelta),
        collateralDeltaUsdc: formatUsdc(order.collateralDelta),
        price: formatPrice(order.price),
        createdAt: new Date(order.createdTimestamp * 1000).toISOString()
      });
    }
  }

  return statusData;
}

async function closePosition(merkle: MerkleClient, aptos: Aptos, account: Account, pairId: string) {
  const positions = await merkle.getPositions({ address: account.accountAddress });
  const target = positions.find((pos: any) => parsePairId(pos.pairType) === pairId);
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

export async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const pairArg = args[1]?.toUpperCase();

  const { merkle, aptos, account } = await bootstrapClients();

  if (command === 'close') {
    const pairId = pairArg ?? 'BTC_USD';
    await closePosition(merkle, aptos, account, pairId);

    // After closing, get updated status
    const statusData = await showStatus(merkle, account);
    const ariesData = await showAriesOverview(aptos, account);
    const hyperionData = await showHyperionOverview();

    const result = {
      action: 'position_closed',
      pairId,
      merkle: statusData,
      aries: ariesData,
      hyperion: hyperionData
    };

    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  // Get all status data
  const statusData = await showStatus(merkle, account);
  const ariesData = await showAriesOverview(aptos, account);
  const hyperionData = await showHyperionOverview();

  const result = {
    merkle: statusData,
    aries: ariesData,
    hyperion: hyperionData
  };

  console.log(JSON.stringify(result, null, 2));
  return result;
}

main().catch((error) => {
  console.error('Positions error:', error);
  process.exitCode = 1;
});

function decodeBytes(data: unknown): string | undefined {
  if (typeof data === 'string') {
    if (data.startsWith('0x')) {
      try {
        return Buffer.from(data.slice(2), 'hex').toString('utf8').replace(/\0+$/, '');
      } catch (error) {
        return undefined;
      }
    }
    return data;
  }
  if (Array.isArray(data)) {
    try {
      return Buffer.from(Uint8Array.from(data as number[])).toString('utf8').replace(/\0+$/, '');
    } catch (error) {
      return undefined;
    }
  }
  return undefined;
}

function formatWithDecimals(value: bigint, decimals: number): string {
  const absolute = Number(value) / 10 ** decimals;
  return Number.isFinite(absolute) ? absolute.toString() : value.toString();
}

function formatAssetAmount(value: bigint, decimals: number, symbol: string, divisorOverride?: bigint): string {
  const divisor = divisorOverride ?? BigInt(10) ** BigInt(decimals);
  if (divisor === 0n) {
    return `${value.toString()} ${symbol}`;
  }
  const numeric = Number(value) / Number(divisor);
  if (Number.isFinite(numeric)) {
    return `${numeric.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: decimals })} ${symbol}`;
  }
  return `${value.toString()} base units (${symbol})`;
}

function extractTableEntries(tableLike: unknown): Array<{ key: any; value: any }> {
  if (!tableLike) return [];

  const walk = (input: unknown): Array<{ key: any; value: any }> => {
    if (!input) return [];
    if (Array.isArray(input)) {
      return input.flatMap((entry) => {
        if (entry && typeof entry === 'object') {
          const key = (entry as any).key ?? (entry as any).fields?.key;
          const value = (entry as any).value ?? (entry as any).fields?.value;
          if (key !== undefined && value !== undefined) {
            return [{ key, value }];
          }
        }
        return [];
      });
    }
    if (typeof input === 'object') {
      const obj = input as Record<string, unknown>;
      if (obj.data) return walk(obj.data);
      if (obj.inner) return walk(obj.inner);
    }
    return [];
  };

  return walk(tableLike);
}

function decodeTypeInfo(typeInfo: any): string | undefined {
  if (!typeInfo) return undefined;
  if (typeof typeInfo === 'string') return typeInfo;

  const addr = typeInfo.account_address ?? typeInfo.address;
  const moduleNameVal = typeInfo.module_name ?? typeInfo.module ?? typeInfo.module_name_hex;
  const structNameVal = typeInfo.struct_name ?? typeInfo.struct ?? typeInfo.struct_name_hex;

  if (!addr || moduleNameVal === undefined || structNameVal === undefined) return undefined;

  const toUtf8 = (value: any) => {
    if (typeof value === 'string') {
      if (value.startsWith('0x')) {
        try {
          return Buffer.from(value.slice(2), 'hex').toString('utf8');
        } catch (error) {
          return value;
        }
      }
      return value;
    }
    if (Array.isArray(value)) {
      try {
        return Buffer.from(Uint8Array.from(value)).toString('utf8');
      } catch (error) {
        return value.toString();
      }
    }
    return String(value ?? '');
  };

  const moduleName = toUtf8(moduleNameVal).replace(/\0+$/, '');
  const structName = toUtf8(structNameVal).replace(/\0+$/, '');
  return `0x${String(addr).replace(/^0x/, '').toLowerCase()}::${moduleName}::${structName}`;
}

async function callAriesView(
  aptos: Aptos,
  coreAddress: string,
  moduleName: string,
  functionName: string,
  typeArguments: string[],
  args: any[],
) {
  const fqn = `${coreAddress}::${moduleName}::${functionName}`;
  return aptos.view({ payload: { function: fqn as any, typeArguments, functionArguments: args } });
}

async function getTypeInfo(aptos: Aptos, typeTag: string) {
  const [typeInfo] = await aptos.view({
    payload: {
      function: '0x1::type_info::type_of',
      typeArguments: [typeTag],
      functionArguments: [],
    },
  });
  return typeInfo;
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
    (reserves as any)?.data?.stats?.inner?.handle;
  if (!statsHandle) throw new Error('Aries reserve stats handle not found');

  const typeInfo = await getTypeInfo(aptos, assetType);

  // try non-generic ReserveStats first
  try {
    return await aptos.getTableItem({
      handle: statsHandle,
      data: {
        key_type: '0x1::type_info::TypeInfo',
        value_type: `${coreAddress}::reserve::ReserveStats`,
        key: typeInfo,
      },
    });
  } catch {
    // fallback: generic ReserveStats<T>
    return await aptos.getTableItem({
      handle: statsHandle,
      data: {
        key_type: '0x1::type_info::TypeInfo',
        value_type: `${coreAddress}::reserve::ReserveStats<${assetType}>`,
        key: typeInfo,
      },
    });
  }
}


function computeAmountFromShares(
  shares: bigint,
  totalAmount: bigint,
  totalShares: bigint,
): bigint {
  if (shares === 0n || totalShares === 0n) return 0n;
  return (shares * totalAmount) / totalShares;
}

async function showAriesOverview(aptos: Aptos, account: Account) {
  console.log('🔍 [DEBUG] showAriesOverview: Getting Aries data for account:', account.accountAddress.toString());

  const ariesAddressRaw = process.env.ARIES_CORE_ADDRESS ?? DEFAULT_ARIES_CORE_ADDRESS;
  const ariesAddress = ariesAddressRaw.toLowerCase();
  const wrappedType = process.env.ARIES_WRAPPED_COLLATERAL_TYPE ?? DEFAULT_WRAPPED_USDC;
  const profileName = process.env.ARIES_PROFILE_NAME ?? 'main';

  console.log('🏦 [DEBUG] showAriesOverview: Aries address:', ariesAddress);
  console.log('🪙 [DEBUG] showAriesOverview: Wrapped type:', wrappedType);
  console.log('👤 [DEBUG] showAriesOverview: Profile name:', profileName);

  const ariesData = {
    wrappedUsdcCoinBalance: '0',
    profileExists: false,
    profileAddress: null as string | null,
    wrappedUsdcDeposited: '0',
    wrappedUsdcShares: '0',
    aptBorrowed: '0',
    aptShares: '0'
  };

  try {
    const coinStoreType = `0x1::coin::CoinStore<${wrappedType}>` as any;
    console.log('🔍 [DEBUG] showAriesOverview: Checking coin store type:', coinStoreType);
    let wrappedBalance = 0n;
    try {
      const coinStore = await aptos.getAccountResource({
        accountAddress: account.accountAddress,
        resourceType: coinStoreType,
      });
      const raw = (coinStore as any)?.data?.coin?.value ?? '0';
      wrappedBalance = BigInt(raw);
      console.log('💰 [DEBUG] showAriesOverview: Raw wrapped balance:', raw);
    } catch (error) {
      console.log('⚠️ [DEBUG] showAriesOverview: Coin store resource missing or error:', (error as Error).message);
      // resource missing means zero balance; ignore
    }

    ariesData.wrappedUsdcCoinBalance = formatWithDecimals(wrappedBalance, ARIES_USDC_DECIMALS);
    console.log('💵 [DEBUG] showAriesOverview: Formatted wrapped balance:', ariesData.wrappedUsdcCoinBalance);

    const accountHex = account.accountAddress.toString();
    const views = [
      {
        key: 'profileExists',
        module: 'profile',
        name: 'profile_exists',
        typeArgs: [],
        args: [accountHex, profileName] as any,
        extract: (result: unknown[]) => result?.[0] ? true : false,
      },
      {
        key: 'profileAddress',
        module: 'profile',
        name: 'get_profile_address',
        typeArgs: [],
        args: [accountHex, profileName] as any,
        extract: (result: unknown[]) => String(result?.[0] ?? 'unknown'),
      },
      {
        key: 'wrappedUsdcDeposit',
        module: 'profile',
        name: 'profile_deposit',
        typeArgs: [wrappedType],
        args: [accountHex, profileName] as any,
        extract: (result: unknown[]) => {
          const values = Array.isArray(result) ? result : [];
          const amountRaw = values[0] ?? '0';
          const sharesRaw = values[1] ?? '0';
          const amount = BigInt(amountRaw);
          const shares = BigInt(sharesRaw);
          return {
            amount: formatAssetAmount(amount, ARIES_USDC_DECIMALS, 'USDC'),
            shares: shares.toString()
          };
        },
      },
      {
        key: 'aptBorrowed',
        module: 'profile',
        name: 'profile_loan',
        typeArgs: ['0x1::aptos_coin::AptosCoin'],
        args: [accountHex, profileName] as any,
        extract: (result: unknown[]) => {
          const v = Array.isArray(result) ? result : [];
          const shares = BigInt(v[0] ?? '0');  // shares FIRST
          const mantissa = BigInt(v[1] ?? '0');  // 1e18 mantissa SECOND
          const baseUnits = mantissa / (10n ** 19n); // 1e18 -> 1e8
          return {
            amount: formatAssetAmount(baseUnits, 8, 'APT'),
            shares: shares.toString()
          };
        },
      },
    ];

    for (const view of views) {
      try {
        const result = await callAriesView(
          aptos,
          ariesAddress,
          view.module,
          view.name,
          view.typeArgs,
          view.args,
        );
        const values = Array.isArray(result) ? result : [];
        const extracted = view.extract(values);

        if (view.key === 'profileExists') {
          ariesData.profileExists = extracted as boolean;
        } else if (view.key === 'profileAddress') {
          ariesData.profileAddress = extracted as string;
        } else if (view.key === 'wrappedUsdcDeposit') {
          const data = extracted as { amount: string; shares: string };
          ariesData.wrappedUsdcDeposited = data.amount;
          ariesData.wrappedUsdcShares = data.shares;
        } else if (view.key === 'aptBorrowed') {
          const data = extracted as { amount: string; shares: string };
          ariesData.aptBorrowed = data.amount;
          ariesData.aptShares = data.shares;
        }
      } catch (error) {
        if (process.env.ARIES_DEBUG === 'true') {
          console.warn(` ${view.key} unavailable:`, (error as Error).message);
        }
      }
    }
  } catch (error) {
    console.warn('Failed to fetch Aries profile information:', (error as Error).message);
  }

  return ariesData;
}

async function showHyperionOverview() {
  return {
    message: 'Hyperion spot swaps are stateless; no open positions to display.'
  };
}
