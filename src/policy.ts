import {
  type Address,
  BaseError,
  ContractFunctionRevertedError,
  decodeErrorResult,
  encodeAbiParameters,
  formatUnits,
  type Hex,
} from "viem";
import { allowanceModuleAbi } from "./abi.js";

export interface TokenLimits {
  /** Largest single payment. A co-signature can't lift it. */
  maxPerTx: bigint;
  /** A single payment above this waits for the co-signer. */
  cosignAbove: bigint;
  /** The window total the agent may reach without the co-signer. */
  autoPerPeriod: bigint;
  /** The window total nobody can exceed, co-signed or not. */
  maxPerPeriod: bigint;
  /** Window length in seconds. */
  period: bigint;
}

export interface InitConfig {
  agents: Address[];
  cosigner: Address;
  recipients: Address[];
  tokens: Array<{ token: Address; limits: TokenLimits }>;
  /** Seconds a queued request waits for a co-signature (0 means one day). */
  pendingTtl: number;
  /** Longest validity an x402 authorization may have (0 means one hour). */
  maxAuthWindow: number;
}

const LIMITS_TUPLE = {
  name: "limits",
  type: "tuple",
  components: [
    { name: "maxPerTx", type: "uint128" },
    { name: "cosignAbove", type: "uint128" },
    { name: "autoPerPeriod", type: "uint128" },
    { name: "maxPerPeriod", type: "uint128" },
    { name: "period", type: "uint64" },
  ],
} as const;

const INIT_CONFIG = [
  {
    type: "tuple",
    components: [
      { name: "agents", type: "address[]" },
      { name: "cosigner", type: "address" },
      { name: "recipients", type: "address[]" },
      {
        name: "tokens",
        type: "tuple[]",
        components: [{ name: "token", type: "address" }, LIMITS_TUPLE],
      },
      { name: "pendingTtl", type: "uint32" },
      { name: "maxAuthWindow", type: "uint32" },
    ],
  },
] as const;

/** ABI-encode the module's `onInstall` data. */
export function encodeInitConfig(cfg: InitConfig): Hex {
  return encodeAbiParameters(INIT_CONFIG, [cfg]);
}

/** A payment the on-chain policy refused, with the contract's reason in words. */
export class PolicyError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly args: readonly unknown[] = [],
  ) {
    super(message);
    this.name = "PolicyError";
  }
}

export interface Units {
  decimals: number;
  symbol: string;
}

const fmt = (v: unknown, u?: Units) =>
  typeof v === "bigint" && u ? `${formatUnits(v, u.decimals)} ${u.symbol}` : String(v);

/** Turn a revert from the module into a sentence an agent (or a person) can act on. */
export function explainPolicyError(name: string, args: readonly unknown[], units?: Units): string {
  switch (name) {
    case "NotAgent":
      return `${args[0]} is not a registered agent key for this account`;
    case "RecipientNotAllowed":
      return `recipient ${args[0]} is not on the account's allowlist; only the account owner can add it`;
    case "TokenNotConfigured":
      return `token ${args[0]} has no spending limits on this account, so it can't be spent`;
    case "ZeroAmount":
      return "amount must be greater than zero";
    case "OverPerTxLimit":
      return `${fmt(args[0], units)} is above the per-payment limit of ${fmt(args[1], units)}`;
    case "OverPeriodLimit":
      return `${fmt(args[0], units)} is more than the ${fmt(args[1], units)} left in this period's hard limit`;
    case "IsPaused":
      return "payments are paused on this account (by its co-signer or owner)";
    case "BadValidity":
      return "the authorization's validity window is too long, already expired, or inverted";
    case "ReservationExists":
      return "this exact authorization is already reserved";
    case "NonceUsed":
      return "this authorization nonce was already used";
    case "NotApprover":
      return `${args[0]} is neither the account's co-signer nor the account`;
    case "UnknownPending":
      return `no open request with id ${args[0]}`;
    case "PendingExpired":
      return `request ${args[0]} expired before it was approved`;
    default:
      return `${name}(${args.map((a) => String(a)).join(", ")})`;
  }
}

/** If `err` is a revert with one of the module's custom errors, return it as a PolicyError. */
export function asPolicyError(err: unknown, units?: Units): PolicyError | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (reverted instanceof ContractFunctionRevertedError && reverted.data?.errorName) {
    const args = reverted.data.args ?? [];
    return new PolicyError(reverted.data.errorName, explainPolicyError(reverted.data.errorName, args, units), args);
  }
  // Some paths surface only raw revert data.
  const raw = err.walk((e) => typeof (e as { data?: unknown }).data === "string") as { data?: Hex } | null;
  if (raw?.data && raw.data.length >= 10) {
    try {
      const decoded = decodeErrorResult({ abi: allowanceModuleAbi, data: raw.data });
      const args = decoded.args ?? [];
      return new PolicyError(decoded.errorName, explainPolicyError(decoded.errorName, args, units), args);
    } catch {
      return undefined;
    }
  }
  return undefined;
}
