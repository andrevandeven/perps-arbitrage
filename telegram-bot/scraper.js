// scraper.js (ESM)
import fs from "fs-extra";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Keep using the same account URL you’re monitoring
const URL =
  "https://aptoscan.com/account/0xa665defb6d736ae6a0d983fd57f26040552c7832757fd325d7633940d6a608d5#transfers";
const SEEN_FILE = path.join(__dirname, "seen_versions.json");

/** Normalize to lowercase 0x-hex */
function normalizeAddr(s) {
  if (!s) return "";
  s = String(s).trim().toLowerCase();
  return s.startsWith("0x") ? s : `0x${s}`;
}

/** Compare possibly-truncated on-page addr (e.g., 0xa665d...6a608d5) to full target */
function sameAddress(observed, target) {
  if (!observed || !target) return false;
  observed = observed.toLowerCase().trim();
  target = target.toLowerCase().trim();
  if (observed.length === target.length) return observed === target;
  return (
    observed.startsWith(target.slice(0, 6)) &&
    observed.endsWith(target.slice(-6))
  );
}

async function loadSeen() {
  try {
    const data = await fs.readFile(SEEN_FILE, "utf8");
    return new Set(JSON.parse(data));
  } catch {
    return new Set();
  }
}

async function saveSeen(seen) {
  try {
    await fs.writeFile(SEEN_FILE, JSON.stringify([...seen].sort()), "utf8");
  } catch {}
}

async function extractFirstRowData(page) {
  await page.waitForSelector("tbody.ant-table-tbody tr.ant-table-row", {
    timeout: 20000,
  });
  const row = await page.$("tbody.ant-table-tbody tr.ant-table-row");
  if (!row) return null;

  const tds = await row.$$("td.ant-table-cell");
  if (tds.length < 7) return null;

  // version (td[1])
  const versionEl = await tds[1].$("a[href^='/transaction/'] span");
  const version = versionEl ? (await versionEl.innerText()).trim() : null;

  // from (td[3])
  let fromAddr = "";
  const fromLink = await tds[3].$("a[href^='/account/']");
  if (fromLink) {
    const href = await fromLink.getAttribute("href"); // /account/<full>
    if (href?.includes("/account/")) fromAddr = href.split("/account/")[1];
  } else {
    const txt = (await tds[3].innerText()).trim();
    fromAddr = txt.split(/\s+/).pop() || "";
  }

  // to (td[4])
  let toAddr = "";
  const toLink = await tds[4].$("a[href^='/account/']");
  if (toLink) {
    const href = await toLink.getAttribute("href");
    if (href?.includes("/account/")) toAddr = href.split("/account/")[1];
  } else {
    toAddr = (await tds[4].innerText()).trim();
  }

  // token symbol (td[5]) – we don’t return it, but keep parsing robust
  const tokenEl =
    (await tds[5].$("div.truncate")) ||
    (await tds[5].$("div[font-size='14']")) ||
    (await tds[5].$(".sc-f324f6a7-0"));
  const tokenSymbol = tokenEl ? (await tokenEl.innerText()).trim() : "UNKNOWN";

  // amount (td[6]) – first number
  const amtTxt = (await tds[6].innerText()).replace(/,/g, " ").trim();
  const m = amtTxt.match(/([0-9]+(?:\.[0-9]+)?)/);
  const amountStr = m ? m[1] : null;

  return { version, fromAddr, toAddr, tokenSymbol, amountStr };
}

/**
 * Check the first transfer row for a new version and possible deposit.
 *
 * @param {string} fromAddress - full hex of expected sender (user)
 * @param {string} toAddress   - full hex of expected recipient (hot wallet)
 * @returns {Promise<[string|null, number|null]>}
 *   - [null, null] : no new version
 *   - [version, 0] : new version but from/to don’t match (mark seen)
 *   - [version, amountNumber] : new version and matches from/to
 */
export async function checkLatestDeposit(fromAddress, toAddress) {
  const targetFrom = normalizeAddr(fromAddress);
  const targetTo = normalizeAddr(toAddress);

  const seen = await loadSeen();

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    });
    const page = await context.newPage();
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    try {
      await page.waitForLoadState("networkidle", { timeout: 15000 });
    } catch {}

    const row = await extractFirstRowData(page);
    if (!row || !row.version) return [null, null];

    // If we’ve already processed this version, no new version.
    if (seen.has(row.version)) return [null, null];

    // It is a new version: mark seen regardless of match so we act once per version.
    seen.add(row.version);
    await saveSeen(seen);

    // Compare addresses (handles truncated display)
    const isFromOk = sameAddress(row.fromAddr, targetFrom);
    const isToOk = sameAddress(row.toAddr, targetTo);

    if (!isFromOk || !isToOk) {
      // New version, but not a deposit we care about
      return [row.version, 0];
    }

    // Parse amount -> number (falls back to 0 if missing)
    const amountNum = row.amountStr ? Number(row.amountStr) : 0;
    return [row.version, amountNum];
  } finally {
    await browser.close();
  }
}