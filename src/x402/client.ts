import { PolicyError } from "../policy.js";
import type { PaymentSigner } from "./signers.js";
import {
  decodeHeader,
  encodeHeader,
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  type SettleResponse,
  X402_VERSION,
} from "./types.js";

export interface X402FetchOptions {
  signer: PaymentSigner;
  /** CAIP-2 network this signer pays on, e.g. "eip155:31337". */
  network: string;
  /** Chain time in seconds; validity windows are computed from it. */
  now: () => Promise<bigint>;
  /** Optional client-side ceiling per request (atomic units). The on-chain policy is the real limit. */
  maxAmount?: bigint;
  init?: RequestInit;
  fetchImpl?: typeof fetch;
}

export type X402Outcome =
  | { status: "free"; response: Response }
  | { status: "paid"; response: Response; requirement: PaymentRequirements; settlement?: SettleResponse; payload: PaymentPayload }
  | { status: "pending" | "rejected" | "expired"; pendingId: bigint; requirement: PaymentRequirements }
  | { status: "refused"; reason: string; code?: string; requirement?: PaymentRequirements; response?: Response };

/** Pick the cheapest `exact` EIP-3009 requirement on our network. */
export function selectRequirement(pr: PaymentRequired, network: string, maxAmount?: bigint): PaymentRequirements | string {
  if (pr.x402Version !== X402_VERSION) return `unsupported x402 version ${pr.x402Version}`;
  const usable = pr.accepts.filter(
    (r) =>
      r.scheme === "exact" &&
      r.network === network &&
      (r.extra?.assetTransferMethod ?? "eip3009") === "eip3009" &&
      /^\d+$/.test(r.amount),
  );
  if (usable.length === 0) return `no "exact" EIP-3009 payment option on ${network}`;
  usable.sort((a, b) => (BigInt(a.amount) < BigInt(b.amount) ? -1 : 1));
  const best = usable[0]!;
  if (maxAmount !== undefined && BigInt(best.amount) > maxAmount) {
    return `price ${best.amount} is above this request's ceiling of ${maxAmount}`;
  }
  return best;
}

/**
 * fetch() that pays x402 v2 "402 Payment Required" responses: read PAYMENT-REQUIRED, authorize the
 * payment with the signer, and retry once with PAYMENT-SIGNATURE.
 */
export async function x402Fetch(url: string, opts: X402FetchOptions): Promise<X402Outcome> {
  const doFetch = opts.fetchImpl ?? fetch;
  const first = await doFetch(url, opts.init);
  if (first.status !== 402) return { status: "free", response: first };

  const header = first.headers.get(HEADER_PAYMENT_REQUIRED);
  if (!header) return { status: "refused", reason: "402 without a PAYMENT-REQUIRED header", response: first };
  let required: PaymentRequired;
  try {
    required = decodeHeader<PaymentRequired>(header);
  } catch {
    return { status: "refused", reason: "malformed PAYMENT-REQUIRED header", response: first };
  }
  const picked = selectRequirement(required, opts.network, opts.maxAmount);
  if (typeof picked === "string") return { status: "refused", reason: picked, response: first };

  let auth;
  try {
    auth = await opts.signer.authorize(picked, await opts.now());
  } catch (err) {
    if (err instanceof PolicyError) return { status: "refused", reason: err.message, code: err.code, requirement: picked };
    throw err;
  }
  if (auth.status === "refused") return { ...auth, requirement: picked };
  if (auth.status !== "ready") return { status: auth.status, pendingId: auth.pendingId, requirement: picked };

  const payload: PaymentPayload = {
    x402Version: X402_VERSION,
    resource: required.resource,
    accepted: picked,
    payload: auth.payload,
  };
  const headers = new Headers(opts.init?.headers);
  headers.set(HEADER_PAYMENT_SIGNATURE, encodeHeader(payload));
  const second = await doFetch(url, { ...opts.init, headers });
  const settleHeader = second.headers.get(HEADER_PAYMENT_RESPONSE);
  const settlement = settleHeader ? decodeHeader<SettleResponse>(settleHeader) : undefined;
  if (!second.ok) {
    return {
      status: "refused",
      reason: `server answered ${second.status}${settlement?.errorReason ? ` (${settlement.errorReason})` : ""}`,
      requirement: picked,
      response: second,
    };
  }
  return { status: "paid", response: second, requirement: picked, settlement, payload };
}
