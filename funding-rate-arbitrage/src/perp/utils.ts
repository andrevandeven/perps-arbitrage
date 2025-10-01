import type { Decimals } from '@merkletrade/ts-sdk';

const USDC_SCALAR = 1_000_000;
const PRICE_SCALAR = 10_000_000_000;
const FUNDING_SCALAR = 100_000_000;

export function formatUsdc(amount: bigint | Decimals.Collateral, digits = 6) {
  return collateralToNumber(amount).toFixed(digits);
}

export function formatPrice(amount: bigint | Decimals.Price, digits = 4) {
  return priceToNumber(amount).toFixed(digits);
}

export function formatFunding(rate: bigint | Decimals.FundingPrecision, digits = 6) {
  return fundingToNumber(rate).toFixed(digits);
}

export function fundingToNumber(rate: bigint | Decimals.FundingPrecision) {
  return Number(rate) / FUNDING_SCALAR;
}

export function priceToNumber(amount: bigint | Decimals.Price) {
  return Number(amount) / PRICE_SCALAR;
}

export function collateralToNumber(amount: bigint | Decimals.Collateral) {
  return Number(amount) / USDC_SCALAR;
}

export function parsePairId(pairType: string) {
  const parts = pairType.split('::');
  return parts[parts.length - 1] ?? pairType;
}

export function formatNumber(value: number, digits = 6) {
  return value.toFixed(digits);
}
