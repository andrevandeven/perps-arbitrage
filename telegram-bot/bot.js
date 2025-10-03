// bot.js (ESM)
import {
  Aptos,
  AptosConfig,
  Network,
  Account,
  Ed25519PrivateKey,
  AccountAddress,
} from "@aptos-labs/ts-sdk";
import { Telegraf } from "telegraf";
import fetch from "node-fetch";
import "dotenv/config";

// ...existing code... (kept the later runTsCli variant below)

import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";


import { main as seePosition } from "../funding-rate-arbitrage/src/perp/positions.ts"

import { main as close_short_spot_long_perp } from "../funding-rate-arbitrage/src/arbitrage/close-short-spot-long-perp.ts";
import { main as close_long_spot_short_perp } from "../funding-rate-arbitrage/src/arbitrage/close-long-spot-short-perp.ts";

import { main as long_spot_short_perp } from "../funding-rate-arbitrage/src/arbitrage/long-spot-short-perp.ts";
import { main as short_spot_long_perp } from "../funding-rate-arbitrage/src/arbitrage/short-spot-long-perp.ts";

import { getFundingRate } from "../funding-rate-arbitrage/src/perp/positions.ts";

import { checkLatestDeposit } from "./scraper.js"; // reusing scraper for indexer helper

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Paths to your TS CLIs
const ARB_ROOT = path.resolve(__dirname, "../funding-rate-arbitrage");
const LONG_CLI = path.join(ARB_ROOT, "src/arbitrage/long-spot-short-perp.ts");
const SHORT_CLI = path.join(ARB_ROOT, "src/arbitrage/short-spot-long-perp.ts");

const CLOSE_LONG_SHORT_CLI = path.join(
  ARB_ROOT,
  "src/arbitrage/close-long-spot-short-perp.ts"
);
const CLOSE_SHORT_LONG_CLI = path.join(
  ARB_ROOT,
  "src/arbitrage/close-short-spot-long-perp.ts"
);

const FORMATTED_APTOS_PK = (() => {
  try {
    return PrivateKey.formatPrivateKey(process.env.APTOS_PK || "", "ed25519");
  } catch (e) {
    console.warn(
      "Warning: could not format APTOS_PK to AIP-80:",
      e?.message || e
    );
    return process.env.APTOS_PK || "";
  }
})();

// Run a TS CLI with npx tsx, in the funding-rate-arbitrage project
function runTsCli(tsFile, args = []) {
  return new Promise((resolve, reject) => {
    const proc = spawn("npx", ["-y", "tsx", tsFile, ...args], {
      cwd: ARB_ROOT, // <<< important: use the arb project folder
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // Inject formatted private key for the child process
        APTOS_PK: FORMATTED_APTOS_PK,
      },
    });
    let out = "",
      err = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (err += d));
    proc.on("close", (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`exit ${code}\n${err || out}`));
    });
  });
}

/* =================== Config =================== */
const BOT_TOKEN = process.env.BOT_TOKEN;
const APTOS_PK = process.env.APTOS_PK;
if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN in environment");
if (!APTOS_PK) throw new Error("Missing APTOS_PK in environment");

console.log(
  "Env: BOT_TOKEN and APTOS_PK presence OK (token not printed for security)"
);

const config = new AptosConfig({ network: Network.MAINNET });
const aptos = new Aptos(config);

// Types / constants
const APT_TYPE = "0x1::aptos_coin::AptosCoin";
const USDC_METADATA =
  "0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b"; // native USDC metadata object id (mainnet)
const USDC_DECIMALS = 6n;
// Aptos REST API and USDC coin type (override with env if needed)
const APTOS_API =
  process.env.APTOS_API || "https://fullnode.mainnet.aptoslabs.com/v1";
const USDC_COIN_TYPE = process.env.USDC_COIN_TYPE || "0x1::usdc::USDC";
// --- Indexer GraphQL (Mainnet) ---
const INDEXER_URL =
  process.env.APTOS_INDEXER_URL ||
  "https://indexer.mainnet.aptoslabs.com/v1/graphql";
const INDEXER_HEADERS = {
  "content-type": "application/json",
  ...(process.env.APTOS_INDEXER_API_KEY
    ? { "x-aptos-api-key": process.env.APTOS_INDEXER_API_KEY }
    : {}),
};

async function gql(query, variables) {
  const res = await fetch(INDEXER_URL, {
    method: "POST",
    headers: INDEXER_HEADERS,
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok)
    throw new Error(`indexer http ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors?.length)
    throw new Error(`indexer gql error: ${JSON.stringify(json.errors)}`);
  return json.data;
}
// Monitoring/event scanning removed per user request.

// Custodial hot wallet (signer + source of funds)
const pk = new Ed25519PrivateKey(APTOS_PK);
export const hotWallet = Account.fromPrivateKey({ privateKey: pk });
const address = hotWallet.accountAddress.toString();

// --- Helper: get USDC deposit activities (FA v2) using the SDK/indexer helper ---
// This uses the SDK's indexer helper which already normalizes FA activities.
async function getUsdcFaActivitiesFor(
  ownerAddress,
  sinceVersion = undefined,
  limit = 25
) {
  console.log("getUsdcFaActivitiesFor: called", {
    ownerAddress,
    sinceVersion,
    limit,
  });
  try {
    const where = {
      owner_address: { _eq: ownerAddress },
      fungible_asset_metadata_address: { _eq: USDC_METADATA }, // FA USDC only
      token_standard: { _eq: "v2" }, // only FA (exclude coin v1)
      is_gas_fee: { _eq: false }, // exclude gas fee noise
      is_transaction_success: { _eq: true },
      type: { _eq: "deposit" }, // only deposits
    };

    if (sinceVersion) {
      where.transaction_version = { _gt: sinceVersion };
    }

    const orderBy = sinceVersion
      ? [{ transaction_version: "asc" }]
      : [{ transaction_version: "desc" }];

    const rows = await aptos.getFungibleAssetActivities({
      where,
      orderBy,
      limit,
    });

    console.log(`getUsdcFaActivitiesFor: fetched ${rows.length} rows`);

    return rows.map((r) => ({
      type: r.type,
      amount: r.amount,
      version: r.transaction_version,
      time: r.transaction_timestamp,
      hash: r.transaction_hash,
      isGas: r.is_gas_fee,
      token_standard: r.token_standard,
      fa_meta: r.fungible_asset_metadata_address,
      owner_address: r.owner_address,
      asset_type: r.asset_type,
    }));
  } catch (err) {
    console.error("getUsdcFaActivitiesFor: error", err?.message || err);
    throw err;
  }
}

function fmtFaAmountStr(amountStr, decimals = Number(USDC_DECIMALS)) {
  // Format base-unit integer string into a human-readable decimal string without
  // converting through Number (avoids precision loss for large integers).
  const s = String(amountStr || "0").replace(/^\+/, "");
  const neg = s.startsWith("-");
  const magnitude = neg ? s.slice(1) : s;
  const padded = magnitude.padStart(decimals + 1, "0");
  const intPart = padded.slice(0, -decimals) || "0";
  let fracPart = padded.slice(-decimals);
  // Trim trailing zeros from fractional part
  fracPart = fracPart.replace(/0+$/, "");

  // Add thousands separators to integer part
  const intWithSep = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  let out = intWithSep;
  if (fracPart.length) out += `.${fracPart}`;
  if (neg) out = `-${out}`;
  return out;
}

// Explorer helpers (URLs for UX links)
const EXPLORER = process.env.EXPLORER_URL || "https://explorer.aptoslabs.com";
const EXPLORER_NET = process.env.EXPLORER_NET || "mainnet";
function explorerTxnUrl(hashOrVersion) {
  return `${EXPLORER}/txn/${hashOrVersion}?network=${EXPLORER_NET}`;
}
function explorerAccountUrl(addr) {
  return `${EXPLORER}/account/${addr}?network=${EXPLORER_NET}`;
}

/* =================== Utils =================== */
function fmtUnits(amountBigInt, decimals = 6) {
  return Number(amountBigInt) / 10 ** decimals;
}

function normalizeAddress(input) {
  // Pads/validates and returns 0x + 64 hex
  return AccountAddress.fromString(String(input || "").trim()).toStringLong();
}

// Optional fee: send 99.5% (50 bps fee). Set to 0n to disable.
const FEE_BPS = 50n;
const BPS_DENOM = 10_000n;

function applyFee(amount) {
  return (amount * (BPS_DENOM - FEE_BPS)) / BPS_DENOM;
}

/* =================== Views =================== */
async function getCoinBalance(type, addr) {
  try {
    const [balanceStr] = await aptos.view({
      payload: {
        function: "0x1::coin::balance",
        typeArguments: [type],
        functionArguments: [addr],
      },
    });
    return BigInt(balanceStr);
  } catch {
    return 0n;
  }
}

async function getUsdcFaBalance(addr) {
  const [bal] = await aptos.view({
    payload: {
      function: "0x1::primary_fungible_store::balance",
      typeArguments: ["0x1::object::ObjectCore"],
      functionArguments: [addr, USDC_METADATA],
    },
  });
  return BigInt(bal); // base units (6 dp)
}

/* =================== Transfers =================== */
// Sends all native USDC (FA) minus fee via 3-arg PFS transfer: (metadata, to, amount)
export async function withdrawAllUsdc(recipientAddress) {
  const senderAddr = hotWallet.accountAddress.toString();
  const recipient = normalizeAddress(recipientAddress);

  console.log("withdrawAllUsdc: called", { senderAddr, recipient });

  const faBal = await getUsdcFaBalance(senderAddr);
  if (faBal === 0n) throw new Error("No USDC (FA) in hot wallet.");

  let amount = applyFee(faBal);
  if (amount <= 0n) throw new Error("Amount after fees is zero.");

  const txn = await aptos.transaction.build.simple({
    sender: senderAddr,
    data: {
      function: "0x1::primary_fungible_store::transfer",
      typeArguments: ["0x1::object::ObjectCore"],
      functionArguments: [USDC_METADATA, recipient, amount.toString()],
    },
  });

  const committed = await aptos.signAndSubmitTransaction({
    signer: hotWallet,
    transaction: txn,
  });
  console.log("withdrawAllUsdc: submitted tx hash", committed.hash);
  await aptos.waitForTransaction({ transactionHash: committed.hash });

  return { amount, txid: committed.hash };
}

// Withdraw a specific USDC amount (base units as BigInt) to recipient
export async function withdrawUsdcAmount(recipientAddress, amountBaseUnits) {
  const senderAddr = hotWallet.accountAddress.toString();
  const recipient = normalizeAddress(recipientAddress);

  if (!amountBaseUnits || amountBaseUnits <= 0n)
    throw new Error("Amount to withdraw must be > 0");

  const txn = await aptos.transaction.build.simple({
    sender: senderAddr,
    data: {
      function: "0x1::primary_fungible_store::transfer",
      typeArguments: ["0x1::object::ObjectCore"],
      functionArguments: [USDC_METADATA, recipient, amountBaseUnits.toString()],
    },
  });

  const committed = await aptos.signAndSubmitTransaction({
    signer: hotWallet,
    transaction: txn,
  });
  console.log("withdrawUsdcAmount: submitted tx hash", committed.hash);
  await aptos.waitForTransaction({ transactionHash: committed.hash });

  return { amount: amountBaseUnits, txid: committed.hash };
}

/* =================== Bot =================== */
const bot = new Telegraf(BOT_TOKEN);

// Single saved wallet (in-memory). Not persisted across restarts.
let savedWallet = null;
let savedChatId = null;

// === Deposit watcher state ===
let depositPollTimer = null;
const seenVersions = new Set();
let totalDeposit = 0;

// Whether the bot is expecting the next text message to be a wallet address
let awaitingWallet = false;

bot.command("address", async (ctx) => {
  await ctx.reply(address);
});

// Set or change wallet via command: /set_wallet <address>
bot.command("set_wallet", async (ctx) => {
  const [, addr] = ctx.message.text.split(/\s+/);
  if (!addr)
    return ctx.reply("Usage: /set_wallet <your_wallet_address> — e.g. 0x...");

  try {
    const normalized = normalizeAddress(addr);
    savedWallet = normalized;
    savedChatId = ctx.chat.id;
    console.log("set_wallet: saved", { normalized, chatId: savedChatId });
    await ctx.reply(`Thanks — I've saved your wallet: ${normalized}`);
    await ctx.reply(
      `I've also saved an explorer link for your wallet: ${explorerAccountUrl(
        normalized
      )}`
    );
    await ctx.reply(
      `Please fund me so I can trade USDC for your wallet ${normalized}. ` +
        `If you need my deposit address in the future, just run /address.`
    );
    // start polling deposits every 10s now that we have a wallet
    startDepositWatcher();
  } catch (e) {
    await ctx.reply(
      `That doesn't look like a valid address: ${e?.message || e}`
    );
  }
});

bot.command("wallet", async (ctx) => {
  if (savedWallet)
    return ctx.reply(
      `Your saved wallet: ${savedWallet} (use /set_wallet to update)`
    );
  return ctx.reply(
    "I don't have your wallet saved yet. Use /set_wallet <address> or send it after /start."
  );
});

bot.command("balance", async (ctx) => {
  console.log("balance: fetching balances for", { address });
  const [aptOctas, usdcFa] = await Promise.all([
    getCoinBalance(APT_TYPE, address),
    getUsdcFaBalance(address),
  ]);
  const aptBal = fmtUnits(aptOctas, 8);
  const usdcBal = fmtUnits(usdcFa, Number(USDC_DECIMALS));
  await ctx.reply(
    `My wallet balances — quick snapshot:\n\nAPT (for gas): ${aptBal}\nUSDC: ${usdcBal}`
  );
});

// Welcome/start flow: short strategy sentence, fee, link, then prompt for wallet
bot.start(async (ctx) => {
  const greeting =
    "Hey there! I look for funding-rate arbitrage between perps and spot to generate returns — I take a 20% fee on profits. Learn more: https://github.com/andrevandeven/perps-arbitrage";
  const prompt =
    "Could you please send your wallet address (e.g. 0x...) so I can save it for future payouts? I'll only use it to send funds.";

  await ctx.reply(greeting);
  await ctx.reply(prompt);

  // mark as awaiting address (single wallet flow)
  awaitingWallet = true;
});

// Handle plain text messages: check if user is expected to send a wallet address
bot.on("text", async (ctx, next) => {
  const text = (ctx.message.text || "").trim();

  if (!awaitingWallet) {
    return next(); // allow command handlers to run
  }

  // attempt to normalize and save
  try {
    const normalized = normalizeAddress(text);
    savedWallet = normalized;
    savedChatId = ctx.chat.id;
    awaitingWallet = false;
    await ctx.reply(`Nice — your wallet ${normalized} is saved.`);
    await ctx.reply(
      `Please fund the trading bot with USDC so it can start trading for you. ` +
        `If you need the bot's deposit address, just run /address.`
    );
    // start polling deposits every 10s now that we have a wallet
    startDepositWatcher();
  } catch (e) {
    await ctx.reply(
      `Hmm, that doesn't look like a valid address. Please send a wallet address starting with 0x.`
    );
  }
});

// Close positions first (perps + spot), then send funds back to user.
bot.command("close_position", async (ctx) => {
  console.log("Close position command received from chat", ctx.chat.id);
  console.log("/close_position invoked", {
    text: ctx.message.text,
    from: ctx.from?.id,
  });

  const [, payoutAddr] = ctx.message.text.split(/\s+/);
  console.log("extracted payoutAddr:", payoutAddr);
  if (!payoutAddr) return ctx.reply("Usage: /close_position <payoutAddress>");

  try {
    // --- 0) Normalize recipient
    console.log("normalizing payout address...");
    const normalized = normalizeAddress(payoutAddr);
    console.log("normalized payout address:", normalized);

    // --- 1) Determine funding-rate sign via your position inspector
    // We try to read an explicit funding rate first; if absent, fall back to accFundingPerSize sign.
    await ctx.reply("Inspecting current position to decide close sequence…");
    let fundingRateSign = 0; // +1 (positive), -1 (negative), 0 (unknown)

    try {
      // If your see_position uses a different import path, adjust this call accordingly:
      // e.g., const pos = await fetchPositionInfo();
      const pos = await seePosition(); // your existing function that returns the JSON you showed

      const p = pos?.merkle?.positions?.[0];

      // Prefer explicit fundingRate if present (e.g., "0.0100%"), else infer from accFundingPerSize
      const parseNum = (x) => {
        if (x == null) return NaN;
        if (typeof x === "number") return x;
        const m = String(x).match(/-?\d+(\.\d+)?/);
        return m ? Number(m[0]) : NaN;
      };

      let fr = parseNum(p?.fundingRate);
      if (!Number.isFinite(fr) || fr === 0) {
        fr = parseNum(p?.accFundingPerSize);
      }
      if (Number.isFinite(fr) && fr !== 0) {
        fundingRateSign = fr > 0 ? +1 : -1;
      }

      console.log("Inferred funding rate sign:", fundingRateSign);
    } catch (err) {
      console.warn("Could not fetch/parse position info to infer funding rate:", err?.message || err);
    }

    // --- 2) Close positions according to funding-rate sign (run CLI files with required args)
    await ctx.reply("Closing open positions on perp + spot legs…");

    // required arg for your close CLIs
    const closeArgs = ["--perp-pair", "APT_USD"];

    try {
      if (fundingRateSign > 0) {
        // Positive funding → close_long_spot_short_perp CLI
        console.log("Funding POSITIVE → close_long_spot_short_perp", closeArgs);
        const out = await runTsCli(CLOSE_LONG_SHORT_CLI, closeArgs);
        if (out) console.log("[close_long_spot_short_perp output]\n" + out);
      } else if (fundingRateSign < 0) {
        // Negative funding → close_short_spot_long_perp CLI
        console.log("Funding NEGATIVE → close_short_spot_long_perp", closeArgs);
        const out = await runTsCli(CLOSE_SHORT_LONG_CLI, closeArgs);
        if (out) console.log("[close_short_spot_long_perp output]\n" + out);
      } else {
        // Unknown: try long/short first, then short/long as fallback.
        console.log("Funding UNKNOWN → try close_long_spot_short_perp then fallback", closeArgs);
        try {
          const out = await runTsCli(CLOSE_LONG_SHORT_CLI, closeArgs);
          if (out) console.log("[close_long_spot_short_perp output]\n" + out);
        } catch (e1) {
          console.warn("close_long_spot_short_perp failed, trying close_short_spot_long_perp:", e1?.message || e1);
          const out2 = await runTsCli(CLOSE_SHORT_LONG_CLI, closeArgs);
          if (out2) console.log("[close_short_spot_long_perp output]\n" + out2);
        }
      }
      await ctx.reply("All positions closed (or no open positions). Proceeding to payout…");
    } catch (closeErr) {
      console.error("Error while closing positions:", closeErr);
      await ctx.reply(`Failed while closing positions: ${closeErr?.message || closeErr}`);
      return;
    }

    // --- 3) Compute payout and send funds
    await ctx.reply("Sending all USDC to your wallet…");
    console.log("fetching current USDC FA balance for hot wallet…");
    const senderAddr = hotWallet.accountAddress.toString();
    const currentBalBase = await getUsdcFaBalance(senderAddr); // BigInt base units

    // totalDeposit tracks deposits in human-readable USDC (not base units)
    const depositHuman = Number(totalDeposit || 0);
    const depositBase = BigInt(Math.round(depositHuman * 10 ** Number(USDC_DECIMALS)));

    // If deposit wasn't tracked, fall back to zero
    const profitBase = currentBalBase > depositBase ? currentBalBase - depositBase : 0n;

    // Bot fee is 20% of profit (rounded down to base unit)
    const FEE_PERCENT = 20n;
    const feeBase = (profitBase * FEE_PERCENT) / 100n;

    // Amount to send to user is current balance minus fee (keep fee in hot wallet)
    const sendBase = currentBalBase > feeBase ? currentBalBase - feeBase : 0n;

    if (sendBase <= 0n) {
      await ctx.reply("No funds available to send after fees.");
      return;
    }

    console.log("calling withdrawUsdcAmount to send user amount...", {
      sendBase: sendBase.toString(),
      feeBase: feeBase.toString(),
      depositBase: depositBase.toString(),
    });

    const res = await withdrawUsdcAmount(normalized, sendBase);
    console.log("withdrawUsdcAmount result:", res);
    const human = fmtUnits(res.amount, Number(USDC_DECIMALS));
    const feeHuman = fmtUnits(feeBase, Number(USDC_DECIMALS));
    await ctx.reply(
      `Success\nAmount sent: ${human} USDC\nFee kept: ${feeHuman} USDC\nTx: ${res.txid}`
    );

    // --- 4) Reset running deposit total
    totalDeposit = 0;
  } catch (e) {
    console.error("/close_position error:", e);
    const errMsg = e?.message || String(e);
    await ctx.reply(`Failed: ${errMsg}`);
  }
});

bot.launch();
console.log("Bot running. Address:", address);

// Expose /history to show recent FA activities for the hot wallet (uses Indexer FA v2)
bot.command("history", async (ctx) => {
  try {
    const target = savedWallet || address;
    const rows = await getUsdcFaActivitiesFor(target, undefined, 25);
    if (!rows.length) return ctx.reply("No recent USDC activity.");

    const lines = rows.slice(0, 10).map((r) => {
      const amt = fmtFaAmountStr(r.amount);
      const kind =
        r.type === "deposit"
          ? "IN +"
          : r.type === "withdraw"
          ? "OUT -"
          : "XFER";
      return `${kind} ${amt} USDC • v${r.version} • ${new Date(
        r.time
      ).toISOString()}\n${explorerTxnUrl(r.hash || r.version)}`;
    });

    await ctx.reply(lines.join("\n\n"));
  } catch (e) {
    await ctx.reply(`Failed to load history: ${e?.message || e}`);
  }
});

// === Helpers for see_position ===
function numFromStr(s) {
  if (s == null) return 0;
  if (typeof s === "number") return s;
  const m = String(s).match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : 0;
}
function fmtUSD(n, dp = 2) {
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
function sumFees(pos) {
  return numFromStr(pos.fundingFeeAccruedUsdc) + numFromStr(pos.rolloverFeeAccruedUsdc);
}
function renderPositionSummary(data) {
  const merkle = data?.merkle || {};
  const aries = data?.aries || {};
  const positions = Array.isArray(merkle.positions) ? merkle.positions : [];

  const freeUSDC = numFromStr(merkle.freeUsdcBalance);
  const wrappedUSDC = numFromStr(aries.wrappedUsdcCoinBalance);
  const wrappedDeposited = numFromStr(aries.wrappedUsdcDeposited);
  const aptBorrowed = numFromStr(aries.aptBorrowed);

  const header = [
    `Account: ${merkle.account || "N/A"}`,
    `Free USDC: $${fmtUSD(freeUSDC)}`,
    `Aries: wrapped USDC bal $${fmtUSD(wrappedUSDC)} • deposited $${fmtUSD(wrappedDeposited)} • APT borrowed ${fmtUSD(aptBorrowed, 6)}`,
  ].join("\n");

  if (positions.length === 0) {
    const hyperionMsg = data?.hyperion?.message ? `\n${data.hyperion.message}` : "";
    return `${header}\n\nNo open perp positions.${hyperionMsg}`;
  }

  // One line per open position
  const lines = positions.map((p, i) => {
    const size = numFromStr(p.sizeUsdc);
    const col = numFromStr(p.collateralUsdc);
    const lev = col > 0 ? size / col : 0;
    const entry = numFromStr(p.averagePrice);
    const mark = numFromStr(p.markPrice);
    const upnl = numFromStr(p.unrealizedPnlUsdc);
    const net = numFromStr(p.netPnlAfterFeesUsdc);
    const fees = sumFees(p);
    const dir = p.direction || "";
    const pair = p.pair || "";
    const ts = p.lastExecTimestamp ? new Date(p.lastExecTimestamp).toISOString().replace(".000Z","Z") : "N/A";
    const sign = net >= 0 ? "+" : "−";
    return `${i+1}. ${pair} ${dir} — size $${fmtUSD(size)}, collateral $${fmtUSD(col)} (${fmtUSD(lev,2)}x), entry ${fmtUSD(entry,4)}, mark ${fmtUSD(mark,4)}, PnL ${sign}$${fmtUSD(Math.abs(net),4)} (U:$${fmtUSD(upnl,4)}, fees $${fmtUSD(fees,4)}), last exec ${ts}`;
  });

  return `${header}\n\nOpen positions (${positions.length}):\n` + lines.join("\n");
}

// === Command: /see_position ===
bot.command("see_position", async (ctx) => {
  try {
    const positionInfo = await seePosition(); // your function returning the JSON payload
    const text = renderPositionSummary(positionInfo);
    await ctx.reply(`Current Position Info:\n${text}`);
  } catch (e) {
    await ctx.reply(`Failed to retrieve position info: ${e?.message || e}`);
  }
});

/* =================== Deposit watcher (webscraper) =================== */
async function pollDepositsOnce() {
  try {
    if (!savedWallet) return;
    const [version, deposit] = await checkLatestDeposit(savedWallet, address);
    if (version === null) return;
    if (seenVersions.has(version)) return;
    seenVersions.add(version);
    if (deposit && deposit > 0) {
      totalDeposit += deposit;
      if (savedChatId) {
        await bot.telegram.sendMessage(
          savedChatId,
          `Deposit detected: +${deposit} USDC\nVersion: ${version}\nTotal: ${totalDeposit} USDC`
        );
      }
      
      // === Immediately deploy the deposit into a position based on funding rate ===
      try {
        const fr = await getFundingRate(); // positive => long spot / short perp; negative => short spot / long perp
        const baseArgs = [
          "--spot-out",
          "5",
          "--perp-pair",
          "APT_USD",
          "--perp-collateral",
          "5",
          "--min-funding",
          "auto",
          "--submit-spot",
          "true",
          "--submit-perp",
          "true"
        ];

        if (typeof fr === "number" && fr > 0) {
          await bot.telegram.sendMessage(
            savedChatId,
            `Funding rate positive (${fr}). Opening Long Spot / Short Perp…`
          );
          const out = await runTsCli(LONG_CLI, baseArgs);
          if (out) console.log("[long_spot_short_perp output]\n" + out);
        } else {
          await bot.telegram.sendMessage(
            savedChatId,
            `Funding rate negative (${fr}). Opening Short Spot / Long Perp…`
          );
          const out = await runTsCli(SHORT_CLI, baseArgs);
          if (out) console.log("[short_spot_long_perp output]\n" + out);
        }
      } catch (tradeErr) {
        console.error("auto-trade after deposit failed:", tradeErr);
        if (savedChatId) {
          await bot.telegram.sendMessage(
            savedChatId,
            `Auto-open failed: ${tradeErr?.message || tradeErr}`
          );
        }
        return; // don’t try to render position if open failed
      }


      // === After positions have been set, send a concise /see_position-style summary ===
      try {
        const data = await seePosition(); // reuse imported seePosition() that returns the same JSON
        const text = renderPositionSummaryCompact(data);
        if (savedChatId) {
          await bot.telegram.sendMessage(savedChatId, `Current Position Info:\n${text}`);
        }
      } catch (summErr) {
        console.warn("could not fetch/render position summary:", summErr?.message || summErr);
      }
    }
  } catch (e) {
    console.error("pollDepositsOnce (scraper):", e?.message || e);
  }
}

function startDepositWatcher() {
  stopDepositWatcher();
  pollDepositsOnce();
  depositPollTimer = setInterval(pollDepositsOnce, 10_000);
}

function stopDepositWatcher() {
  if (depositPollTimer) {
    clearInterval(depositPollTimer);
    depositPollTimer = null;
  }
}

// === Minimal, compact renderer (kept local to avoid touching your /see_position) ===
function renderPositionSummaryCompact(data) {
  const merkle = data?.merkle || {};
  const aries = data?.aries || {};
  const positions = Array.isArray(merkle.positions) ? merkle.positions : [];
  const free = toNum(merkle.freeUsdcBalance);
  const wBal = toNum(aries.wrappedUsdcCoinBalance);
  const head = `Account: ${merkle.account || "N/A"}\nFree USDC: ${fmt2(free)} • Aries wrapped: ${fmt2(wBal)}`;
  if (!positions.length) {
    return `${head}\nNo open perp positions.`;
  }
  const p = positions[0];
  const size = toNum(p.sizeUsdc);
  const col = toNum(p.collateralUsdc);
  const lev = col > 0 ? size / col : 0;
  const entry = toNum(p.averagePrice);
  const mark = toNum(p.markPrice);
  const net = toNum(p.netPnlAfterFeesUsdc);
  const sign = net >= 0 ? "+" : "−";
  return `${head}\n${p.pair || ""} ${p.direction || ""} — size $${fmt2(size)}, collat $${fmt2(col)} (${fmt2(lev)}x)\nentry ${fmt4(entry)}, mark ${fmt4(mark)}, PnL ${sign}$${fmt4(Math.abs(net))}`;
}
function toNum(x){ if(x==null) return 0; if(typeof x==="number") return x; const m=String(x).match(/-?\d+(?:\.\d+)?/); return m?Number(m[0]):0; }
function fmt2(n){ return Number(n).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}); }
function fmt4(n){ return Number(n).toLocaleString(undefined,{minimumFractionDigits:4,maximumFractionDigits:4}); }