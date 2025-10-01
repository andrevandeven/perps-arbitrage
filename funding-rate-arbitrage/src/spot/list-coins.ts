import 'dotenv/config';
import { initHyperionSDK } from '@hyperionxyz/sdk';
import { Network } from '@aptos-labs/ts-sdk';

type Args = {
  network?: string;
};

function parseArgs(argv: string[]): Args {
  const result: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) continue;
    i += 1;
    if (key === 'network') {
      result.network = next;
    }
  }
  return result;
}

function resolveNetwork(value: string | undefined): Network {
  const resolved = (value ?? process.env.HYPERION_NETWORK ?? 'mainnet').toLowerCase();
  if (resolved === 'mainnet') {
    return Network.MAINNET;
  }
  if (resolved === 'testnet') {
    return Network.TESTNET;
  }
  throw new Error(`Unsupported Hyperion network '${resolved}'. Use 'mainnet' or 'testnet'.`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const network = resolveNetwork(args.network);

  const sdk = initHyperionSDK({
    network,
    APTOS_API_KEY: process.env.APTOS_API_KEY ?? '',
  });

  console.log(`Listing Hyperion coins for ${network}...`);
  const pools = await sdk.Pool.fetchAllPools();

  const coinMap = new Map<string, { symbol?: string; name?: string; faType?: string }>();
  const faMap = new Map<string, { symbol?: string; name?: string; coinType?: string }>();

  for (const pool of pools ?? []) {
    const token1 = pool?.pool?.token1Info;
    const token2 = pool?.pool?.token2Info;
    if (token1?.coinType) {
      coinMap.set(token1.coinType, {
        symbol: token1.symbol,
        name: token1.name,
        faType: token1.faType,
      });
    }
    if (token1?.faType) {
      faMap.set(token1.faType, {
        symbol: token1.symbol,
        name: token1.name,
        coinType: token1.coinType,
      });
    }
    if (token2?.coinType) {
      coinMap.set(token2.coinType, {
        symbol: token2.symbol,
        name: token2.name,
        faType: token2.faType,
      });
    }
    if (token2?.faType) {
      faMap.set(token2.faType, {
        symbol: token2.symbol,
        name: token2.name,
        coinType: token2.coinType,
      });
    }
  }

  if (coinMap.size === 0 && faMap.size === 0) {
    console.log('No tokens discovered.');
    return;
  }

  if (coinMap.size > 0) {
    console.log('\nBy coinType:');
    for (const [coinType, info] of coinMap.entries()) {
      const symbol = info.symbol ?? '???';
      const name = info.name ?? '';
      const faType = info.faType ?? 'n/a';
      console.log(`${symbol.padEnd(10)} ${name.padEnd(20)} coinType=${coinType}  faType=${faType}`);
    }
  }

  if (faMap.size > 0) {
    console.log('\nBy faType:');
    for (const [faType, info] of faMap.entries()) {
      const symbol = info.symbol ?? '???';
      const name = info.name ?? '';
      const coinType = info.coinType ?? 'n/a';
      console.log(`${symbol.padEnd(10)} ${name.padEnd(20)} faType=${faType}  coinType=${coinType}`);
    }
  }
}

main().catch((error) => {
  console.error('List coins error:', error);
  process.exitCode = 1;
});
