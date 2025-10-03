import { Account, Aptos } from '@aptos-labs/ts-sdk';

const textEncoder = new TextEncoder();

type NumericInput = number | string | bigint;

const DEFAULT_PROFILE = 'main';

const MAX_U64 = (1n << 64n) - 1n;

export type AriesBorrowOptions = {
  aptos: Aptos;
  account: Account;
  coreAddress: string;
  moduleName?: string;
  registerModuleName?: string;
  depositModuleName?: string;
  withdrawModuleName?: string;
  collateralType: string;
  collateralAmount: NumericInput;
  borrowType: string;
  borrowAmount: NumericInput;
  collateralKind?: 'coin' | 'fa';
  borrowKind?: 'coin' | 'fa';
  wrappedCollateralType?: string;
  profileName?: string;
  repayOnly?: boolean;
  allowBorrow?: boolean;
  skipRegistration?: boolean;
  skipDeposit?: boolean;
  waitForSuccess?: boolean;
};

export type AriesBorrowResult = {
  registerTxHash?: string;
  depositTxHash?: string;
  borrowTxHash?: string;
};

async function getExistingCollateral(
  aptos: Aptos,
  account: Account,
  coreAddress: string,
  profileName: string,
  collateralType: string,
): Promise<bigint> {
  try {
    const result = await aptos.view({
      payload: {
        function: `${coreAddress}::profile::profile_deposit`,
        typeArguments: [collateralType],
        functionArguments: [account.accountAddress.toString(), profileName],
      },
    });
    const values = Array.isArray(result) ? result : [];
    const amountRaw = values[0] ?? '0';
    return BigInt(String(amountRaw));
  } catch (error) {
    // Profile doesn't exist or no deposit, return 0
    return 0n;
  }
}

async function getRequiredCollateral(
  aptos: Aptos,
  coreAddress: string,
  borrowType: string,
  borrowAmount: bigint,
): Promise<bigint> {
  try {
    // Get the collateral factor for the borrow asset
    // This is a simplified approach - in production you'd query the actual health factor requirements
    await aptos.view({
      payload: {
        function: `${coreAddress}::reserve::get_reserve_config`,
        typeArguments: [borrowType],
        functionArguments: [],
      },
    });

    // Typically collateral factor is around 0.75-0.85
    // We'll use a conservative 1.5x multiplier (1/0.67 collateral factor) for safety
    // This means for every $1 borrowed, we need $1.50 in collateral
    return (borrowAmount * 3n) / 2n;
  } catch {
    // Fallback to 2x collateral requirement if we can't fetch config
    return borrowAmount * 2n;
  }
}

export async function borrowWithAries(options: AriesBorrowOptions): Promise<AriesBorrowResult> {
  const {
    aptos,
    account,
    collateralAmount,
    borrowAmount,
    collateralType,
    wrappedCollateralType,
    borrowType,
    skipRegistration = false,
    skipDeposit = false,
    repayOnly = false,
    allowBorrow = true,
    waitForSuccess = true,
    collateralKind = 'coin',
    borrowKind = 'coin',
    registerModuleName,
    depositModuleName,
    withdrawModuleName,
  } = options;

  const coreAddress = normalizeAddress(options.coreAddress);
  const baseModule = options.moduleName ?? 'controller';
  const registerModule = registerModuleName ?? baseModule;
  const depositModule = depositModuleName ?? baseModule;
  const withdrawModule = withdrawModuleName ?? baseModule;

  const profileBytes = encodeProfile(options.profileName ?? DEFAULT_PROFILE);
  const profileName = options.profileName ?? DEFAULT_PROFILE;

  // Aries docs expect deposit/withdraw entry functions with repay_only/allow_borrow flags.

  let registerTxHash: string | undefined;
  if (!skipRegistration) {
    try {
      registerTxHash = await submitEntryFunction({
        aptos,
        account,
        waitForSuccess,
        data: {
          function: buildFunction(coreAddress, registerModule, 'register_user'),
          typeArguments: [],
          functionArguments: [profileBytes],
        },
      });
    } catch (error) {
      if (!isAlreadyRegistered(error)) {
        throw error;
      }
    }
  }

  let depositTxHash: string | undefined;

  if (!skipDeposit) {
    // Check existing collateral
    const existingCollateral = await getExistingCollateral(
      aptos,
      account,
      coreAddress,
      profileName,
      wrappedCollateralType ?? collateralType,
    );

    // Calculate required collateral for this borrow
    const borrowAmountBigInt = BigInt(toU64String(borrowAmount, 'borrowAmount'));
    const requiredCollateral = await getRequiredCollateral(
      aptos,
      coreAddress,
      borrowType,
      borrowAmountBigInt,
    );

    // Calculate how much more collateral we need
    const collateralDeficit = requiredCollateral > existingCollateral
      ? requiredCollateral - existingCollateral
      : 0n;

    let actualDepositAmount = 0n;

    // Minimum deposit threshold - don't deposit amounts smaller than 0.01 USDC (10000 base units)
    const MIN_DEPOSIT_THRESHOLD = 10000n;

    if (collateralDeficit > MIN_DEPOSIT_THRESHOLD) {
      // We have a meaningful deficit - need to deposit more
      const requestedAmount = BigInt(toU64String(collateralAmount, 'collateralAmount'));

      if (requestedAmount === 0n) {
        // No amount specified, deposit exactly what's needed
        actualDepositAmount = collateralDeficit;
        console.log(`Existing collateral: ${existingCollateral}`);
        console.log(`Required collateral: ${requiredCollateral}`);
        console.log(`Auto-depositing deficit: ${actualDepositAmount}`);
      } else {
        // Amount was specified, use the minimum of requested and needed
        actualDepositAmount = requestedAmount < collateralDeficit
          ? requestedAmount
          : collateralDeficit;
        console.log(`Existing collateral: ${existingCollateral}`);
        console.log(`Required collateral: ${requiredCollateral}`);
        console.log(`Depositing: ${actualDepositAmount} (requested: ${requestedAmount}, needed: ${collateralDeficit})`);
      }
    } else if (collateralDeficit > 0n) {
      console.log(`Collateral deficit (${collateralDeficit}) is negligible (< 0.01 USDC), skipping deposit`);
      actualDepositAmount = 0n;
    } else {
      console.log(`Sufficient collateral already deposited (${existingCollateral}), skipping deposit`);
      actualDepositAmount = 0n;
    }

    if (actualDepositAmount > 0n) {
      const depositFunction = collateralKind === 'fa'
        ? buildFunction(coreAddress, depositModule, 'deposit_fa')
        : buildFunction(coreAddress, depositModule, 'deposit');

      const functionArguments = collateralKind === 'fa'
        ? [profileBytes, actualDepositAmount.toString()]
        : [
          profileBytes,
          actualDepositAmount.toString(),
          repayOnly,
        ];

      depositTxHash = await submitEntryFunction({
        aptos,
        account,
        waitForSuccess,
        data: {
          function: depositFunction,
          typeArguments: [normalizeTypeTag(wrappedCollateralType ?? collateralType)],
          functionArguments,
        },
      });
    }
  }

  let borrowTxHash: string | undefined;

  const borrowAmountU64 = toU64String(borrowAmount, 'borrowAmount');
  const shouldBorrow = !repayOnly && borrowAmountU64 !== '0';

  if (shouldBorrow) {
    borrowTxHash = await submitEntryFunction({
      aptos,
      account,
      waitForSuccess,
      data: {
        function: buildFunction(coreAddress, withdrawModule, 'withdraw'),
        typeArguments: [normalizeTypeTag(borrowType)],
        functionArguments: [
          profileBytes,
          borrowAmountU64,
          allowBorrow,
        ],
      },
    });
  }

  return {
    registerTxHash,
    depositTxHash,
    borrowTxHash,
  };
}

type SubmitArgs = {
  aptos: Aptos;
  account: Account;
  waitForSuccess: boolean;
  data: {
    function: string;
    typeArguments: string[];
    functionArguments: Array<Uint8Array | string | boolean | number | bigint>;
  };
};

async function submitEntryFunction(args: SubmitArgs): Promise<string> {
  const { aptos, account, waitForSuccess, data } = args;
  const rawTxn = await aptos.transaction.build.simple({
    sender: account.accountAddress,
    data: {
      function: data.function as `${string}::${string}::${string}`,
      typeArguments: data.typeArguments,
      functionArguments: data.functionArguments,
    },
  });

  const pending = await aptos.signAndSubmitTransaction({ signer: account, transaction: rawTxn });

  if (waitForSuccess) {
    await aptos.waitForTransaction({ transactionHash: pending.hash, options: { checkSuccess: true } });
  }

  return pending.hash;
}

function encodeProfile(profile: string): Uint8Array {
  if (!profile) {
    throw new Error('Aries profile name must be a non-empty string.');
  }
  return textEncoder.encode(profile);
}

function toU64String(value: NumericInput, label: string): string {
  if (typeof value === 'bigint') {
    if (value < 0n || value > MAX_U64) {
      throw new Error(`${label} is outside the u64 range.`);
    }
    return value.toString();
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(value)) {
      throw new Error(`${label} must be a non-negative safe integer.`);
    }
    return Math.trunc(value).toString();
  }

  if (typeof value === 'string') {
    const normalized = value.trim();
    if (!/^[0-9]+$/.test(normalized)) {
      throw new Error(`${label} must be a base-10 u64 string.`);
    }
    const parsed = BigInt(normalized);
    if (parsed > MAX_U64) {
      throw new Error(`${label} exceeds the u64 maximum.`);
    }
    return normalized;
  }

  throw new Error(`${label} must be a string, number, or bigint.`);
}

function buildFunction(coreAddress: string, moduleName: string, functionName: string): string {
  const normalizedModule = moduleName.trim();
  if (!normalizedModule) {
    throw new Error('moduleName must be a non-empty string.');
  }
  return `${coreAddress}::${normalizedModule}::${functionName}`;
}

function normalizeAddress(address: string): string {
  const value = address.trim();
  if (!value) {
    throw new Error('Aries core address is required.');
  }
  return value.startsWith('0x') ? value.toLowerCase() : `0x${value.toLowerCase()}`;
}

function normalizeTypeTag(typeTag: string): string {
  const normalized = typeTag.trim();
  if (!normalized) {
    throw new Error('Type tag must be a non-empty string.');
  }
  return normalized;
}

function isAlreadyRegistered(error: unknown): boolean {
  const message = extractErrorMessage(error);
  return message.includes('already registered')
    || message.includes('user_exists')
    || message.includes('profile_already_exist');
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message.toLowerCase();
  }
  if (typeof error === 'string') {
    return error.toLowerCase();
  }
  return String(error ?? '').toLowerCase();
}
