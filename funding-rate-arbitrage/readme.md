# Funding Rate Arbitrage – Merkle SDK Bootstrap

This project bootstraps a Merkle Trade integration on Aptos. The initial script connects to the REST and WebSocket APIs so you can build a funding-rate arbitrage bot on top.

## Setup

1. Install dependencies:
   ```bash
   npm install
   # or
   yarn install
   ```
2. Configure environment:
   ```bash
   cp .env.example .env
   ```
   Fill `PRIVATE_KEY` with your Aptos **mainnet** private key (0x-prefixed hex).
## Usage

Run the bootstrap script:
```bash
npm run start
# watch mode
npm run dev
```

Run positions overview:
```bash
npm run positions
# close a specific position (default BTC_USD)
npm run positions -- close BTC_USD
```

Run Hyperion pool listing:
```bash
npm run hyperion:list-pools
```

Run combined spot/perp helper:
```bash
npm run arb:long-spot-short-perp -- \\
  --spot-from-fa 0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b \\
  --spot-to-fa   0xa \\
  --spot-out 100 \\
  --spot-out-decimals 8 \\
  --network mainnet \\
  --safe-mode false \\
  --perp-pair APT_USD \\
  --perp-network mainnet \\
  --min-funding auto
```
Passing `--min-funding auto` prints the hold duration needed to break even given current funding and cost assumptions. Provide a numeric value (e.g. `--min-funding 0.015`) to evaluate the hold time at a hypothetical %/hr funding rate. Defaults use Hyperion’s FA addresses per network (APT mainnet `0xa`, USDC mainnet `0xbae207…`, etc.), so you can omit the flags once you’re satisfied with the preset pairings.

Run Merkle USDC faucet (**testnet only**, requires testnet key):
```bash
npm run faucet
```

The bootstrap script:
- Instantiates Merkle REST + WebSocket clients and the Aptos SDK
- Fetches summary, funding rate, and BTC market info
- Subscribes to a single BTC price update over WebSocket
- Places a small test market order if USDC balance allows
- Prints the Aptos chain ID (ensuring the signer works)
- Check live balances and open interest with `npm run positions`


## Next Steps

- Add funding-rate calculations via `@merkletrade/ts-sdk` helpers in `calc/`
- Tune trade sizing/logic before submitting live orders
- Persist positions/orders and incorporate arbitrage logic across venues

Happy hacking!
