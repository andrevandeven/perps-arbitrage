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

  console.log(`Listing Hyperion pools for ${network}...`);
  const pools = await sdk.Pool.fetchAllPools();

  if (!pools || pools.length === 0) {
    console.log('No pools returned.');
    return;
  }

  for (const pool of pools) {
    const info = pool.pool;
    const token1 = info?.token1Info;
    const token2 = info?.token2Info;
    console.log({
      poolId: info?.poolId,
      feeTier: info?.feeTier,
      token1Symbol: token1?.symbol,
      token1Fa: token1?.faType,
      token2Symbol: token2?.symbol,
      token2Fa: token2?.faType,
    });
  }
}

main().catch((error) => {
  console.error('List pools error:', error);
  process.exitCode = 1;
});
