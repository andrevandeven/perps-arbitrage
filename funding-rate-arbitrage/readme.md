# Funding Rate Arbitrage Telegram Bot

This project provides an automated Telegram bot for funding rate arbitrage on Aptos using Merkle Trade perpetuals and Hyperion spot DEX. The bot automatically monitors deposits, executes arbitrage strategies, and manages position closures.

## Features

- **Automated Deposit Monitoring**: Watches for USDC deposits and automatically executes arbitrage
- **Funding Rate Analysis**: Analyzes current funding rates to determine optimal strategy
- **Dual Strategy Support**: 
  - Long Spot + Short Perp (when funding rate is positive)
  - Short Spot + Long Perp (when funding rate is negative)
- **Position Management**: View positions, close positions, and withdraw profits
- **Aries Protocol Integration**: Borrows APT for short strategies
- **Real-time Notifications**: Telegram updates for all actions

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Environment Configuration

```bash
cp .env.example .env
```

Fill in your environment variables:

```env
# Required
PRIVATE_KEY=0x...                    # Your Aptos mainnet private key
TELEGRAM_BOT_TOKEN=...               # Your Telegram bot token
APTOS_API_KEY=...                    # Aptos API key for Hyperion

# Optional (defaults provided)
ARIES_CORE_ADDRESS=0x9770fa9c725cbd97eb50b2be5f7416efdfd1f1554beb0750d4dae4c64e860da3
ARIES_WRAPPED_COLLATERAL_TYPE=0x9770fa9c725cbd97eb50b2be5f7416efdfd1f1554beb0750d4dae4c64e860da3::wrapped_coins::WrappedUSDC
ARIES_PROFILE_NAME=main
```

### 3. Start the Bot

```bash
# Start the Telegram bot
node telegram-bot/bot.js
```

## Bot Commands

### `/start`
Initialize the bot and get your wallet address for deposits.

### `/see_position`
View your current positions, balances, and P&L across:
- **Merkle Trade**: Perpetual positions and USDC balance
- **Aries Protocol**: Borrowed APT and deposited USDC
- **Hyperion**: Spot trading status

### `/close_position <payout_address>`
Close all open positions and send profits to the specified address:
- Automatically detects position direction (LONG/SHORT)
- Closes both spot and perpetual legs
- Repays any outstanding Aries loans
- Sends all USDC to your payout address

Example:
```
/close_position 0x1234567890abcdef...
```

## How It Works

### 1. Deposit Monitoring
- Bot watches for USDC deposits to your wallet
- When a deposit is detected, it automatically analyzes the current funding rate
- Executes the appropriate arbitrage strategy

### 2. Strategy Selection
- **Positive Funding Rate**: Long APT on Hyperion + Short APT perp on Merkle
- **Negative Funding Rate**: Short APT (borrow from Aries) + Long APT perp on Merkle

### 3. Position Management
- Bot monitors positions and funding rates
- Provides real-time updates via Telegram
- Handles both opening and closing positions

## Manual Commands

You can also run arbitrage strategies manually:

### Long Spot + Short Perp
```bash
npm run arb:long-spot-short-perp -- \
  --spot-out 5 \
  --perp-pair APT_USD \
  --perp-collateral 5 \
  --min-funding auto \
  --submit-spot true \
  --submit-perp true
```

### Short Spot + Long Perp
```bash
npm run arb:short-spot-long-perp -- \
  --spot-out 5 \
  --perp-pair APT_USD \
  --perp-collateral 5 \
  --min-funding auto \
  --submit-spot true \
  --submit-perp true
```

### Close Positions
```bash
# Close long spot + short perp
npm run arb:close-long-spot-short-perp -- --perp-pair APT_USD

# Close short spot + long perp  
npm run arb:close-short-spot-long-perp -- --perp-pair APT_USD
```

### View Positions
```bash
npm run positions
```

## Strategy Parameters

- `--spot-out`: Amount to trade on spot (APT amount)
- `--perp-pair`: Perpetual pair (default: APT_USD)
- `--perp-collateral`: Collateral for perp position (USDC)
- `--min-funding`: Minimum funding rate threshold
- `--submit-spot`: Execute spot transactions (true/false)
- `--submit-perp`: Execute perp transactions (true/false)

## Safety Features

- **Dry Run Mode**: Test strategies without executing transactions
- **Slippage Protection**: Configurable slippage tolerance
- **Position Limits**: Automatic position sizing based on funding rates
- **Error Handling**: Comprehensive error reporting and recovery

## Troubleshooting

### Bot Not Responding
- Check that your Telegram bot token is correct
- Verify your private key is properly formatted (0x-prefixed hex)
- Ensure all environment variables are set

### Position Not Closing
- Use `/see_position` to check current positions
- Verify the position direction matches the close function
- Check for sufficient USDC balance for gas fees

### Funding Rate Issues
- Bot automatically detects funding rates
- Manual strategies can specify `--min-funding auto` for automatic analysis
- Use `npm run positions` to see current funding rates

## Support

For issues or questions:
1. Check the bot logs for error messages
2. Use `/see_position` to verify account status
3. Test with small amounts first
4. Ensure sufficient USDC balance for gas fees

Happy arbitraging! 🚀