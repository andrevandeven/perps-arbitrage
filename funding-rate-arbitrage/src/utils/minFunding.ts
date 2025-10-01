export type MinFundingInputs = {
  spotRoundTripBps?: number;
  perpRoundTripBps?: number;
  gasRoundTripBps?: number;
  capitalAprPct?: number;
  holdHours?: number;
  fundingStdPctPerHr?: number;
  zScore?: number;
  extraBasisPremiumPctPerHr?: number;
};

type NormalizedInputs = Required<Pick<MinFundingInputs,
  'spotRoundTripBps'
  | 'perpRoundTripBps'
  | 'gasRoundTripBps'
  | 'capitalAprPct'
  | 'holdHours'
  | 'fundingStdPctPerHr'
  | 'zScore'
  | 'extraBasisPremiumPctPerHr'
>>;

export type MinFundingBreakdown = {
  totalPctPerHour: number;
  breakevenPctPerHour: number;
  tradingCostPctPerHour: number;
  capitalCostPctPerHour: number;
  riskBufferPctPerHour: number;
  basisPremiumPctPerHour: number;
  normalizedInputs: NormalizedInputs;
};

export type BreakevenHoldResult = {
  breakevenPossible: boolean;
  holdHours?: number;
  holdDays?: number;
  tradingCostPct: number;
  netFundingPerHour: number;
  normalizedInputs: NormalizedInputs;
};

function normalizeInputs(inputs: MinFundingInputs): NormalizedInputs {
  return {
    spotRoundTripBps: Number.isFinite(inputs.spotRoundTripBps)
      ? (inputs.spotRoundTripBps as number)
      : 0,
    perpRoundTripBps: Number.isFinite(inputs.perpRoundTripBps)
      ? (inputs.perpRoundTripBps as number)
      : 0,
    gasRoundTripBps: Number.isFinite(inputs.gasRoundTripBps)
      ? (inputs.gasRoundTripBps as number)
    : 0,
    capitalAprPct: Number.isFinite(inputs.capitalAprPct)
      ? (inputs.capitalAprPct as number)
      : 0,
    holdHours: Number.isFinite(inputs.holdHours) && (inputs.holdHours as number) > 0
      ? (inputs.holdHours as number)
      : 1,
    fundingStdPctPerHr: Number.isFinite(inputs.fundingStdPctPerHr)
      ? (inputs.fundingStdPctPerHr as number)
      : 0,
    zScore: Number.isFinite(inputs.zScore) ? (inputs.zScore as number) : 0,
    extraBasisPremiumPctPerHr: Number.isFinite(inputs.extraBasisPremiumPctPerHr)
      ? (inputs.extraBasisPremiumPctPerHr as number)
      : 0,
  };
}

export function computeMinFundingBreakdown(
  inputs: MinFundingInputs,
): MinFundingBreakdown {
  const normalized = normalizeInputs(inputs);

  const spotCostPct = normalized.spotRoundTripBps / 100;
  const perpCostPct = normalized.perpRoundTripBps / 100;
  const gasCostPct = normalized.gasRoundTripBps / 100;

  const tradingCostPctPerHour =
    (spotCostPct + perpCostPct + gasCostPct) / normalized.holdHours;

  const capitalCostPctPerHour =
    normalized.capitalAprPct / 100 / (365 * 24);

  const breakevenPctPerHour = tradingCostPctPerHour + capitalCostPctPerHour;

  const riskBufferPctPerHour =
    normalized.zScore * normalized.fundingStdPctPerHr;
  const basisPremiumPctPerHour = normalized.extraBasisPremiumPctPerHr;

  const totalPctPerHour =
    breakevenPctPerHour + riskBufferPctPerHour + basisPremiumPctPerHour;

  return {
    totalPctPerHour,
    breakevenPctPerHour,
    tradingCostPctPerHour,
    capitalCostPctPerHour,
    riskBufferPctPerHour,
    basisPremiumPctPerHour,
    normalizedInputs: normalized,
  };
}

export function computeMinFundingPctPerHour(inputs: MinFundingInputs): number {
  return computeMinFundingBreakdown(inputs).totalPctPerHour;
}

export function computeBreakevenHoldDuration(
  inputs: MinFundingInputs,
  fundingPctPerHour: number,
): BreakevenHoldResult {
  const normalized = normalizeInputs(inputs);

  const spotCostPct = normalized.spotRoundTripBps / 100;
  const perpCostPct = normalized.perpRoundTripBps / 100;
  const gasCostPct = normalized.gasRoundTripBps / 100;
  const tradingCostPct = spotCostPct + perpCostPct + gasCostPct;

  const capitalCostPctPerHour = normalized.capitalAprPct / 100 / (365 * 24);
  const riskBufferPctPerHour = normalized.zScore * normalized.fundingStdPctPerHr;
  const basisPremiumPctPerHour = normalized.extraBasisPremiumPctPerHr;

  const netFundingPerHour =
    fundingPctPerHour
    - capitalCostPctPerHour
    - riskBufferPctPerHour
    - basisPremiumPctPerHour;

  if (!Number.isFinite(fundingPctPerHour) || netFundingPerHour <= 0) {
    return {
      breakevenPossible: false,
      tradingCostPct,
      netFundingPerHour,
      normalizedInputs: normalized,
    };
  }

  const holdHours = tradingCostPct / netFundingPerHour;

  if (!Number.isFinite(holdHours) || holdHours < 0) {
    return {
      breakevenPossible: false,
      tradingCostPct,
      netFundingPerHour,
      normalizedInputs: normalized,
    };
  }

  return {
    breakevenPossible: true,
    holdHours,
    holdDays: holdHours / 24,
    tradingCostPct,
    netFundingPerHour,
    normalizedInputs: normalized,
  };
}
