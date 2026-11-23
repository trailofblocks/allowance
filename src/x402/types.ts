/**
 * x402 protocol v2 wire types, as used by the `exact` scheme on EVM with EIP-3009.
 * Source: specs/x402-specification-v2.md, specs/transports-v2/http.md, and
 * specs/schemes/exact/scheme_exact_evm.md in github.com/x402-foundation/x402 (spec v2, 2025-12-09).
 */

export const X402_VERSION = 2;

/** HTTP headers. Each carries base64-encoded JSON. */
export const HEADER_PAYMENT_REQUIRED = "PAYMENT-REQUIRED";
export const HEADER_PAYMENT_SIGNATURE = "PAYMENT-SIGNATURE";
export const HEADER_PAYMENT_RESPONSE = "PAYMENT-RESPONSE";

export interface ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
}

export interface PaymentRequirements {
  scheme: string;
  /** CAIP-2, e.g. "eip155:8453". */
  network: string;
  /** Atomic token units, as a decimal string. */
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  /** For EIP-3009: the token's EIP-712 domain `name` and `version`. */
  extra?: { name?: string; version?: string; assetTransferMethod?: string; [k: string]: unknown };
}

export interface PaymentRequired {
  x402Version: number;
  error?: string;
  resource: ResourceInfo;
  accepts: PaymentRequirements[];
  extensions?: Record<string, unknown>;
}

export interface ExactEvmAuthorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  /** bytes32 hex */
  nonce: string;
}

export interface ExactEvmPayload {
  signature: string;
  authorization: ExactEvmAuthorization;
}

export interface PaymentPayload {
  x402Version: number;
  resource?: ResourceInfo;
  accepted: PaymentRequirements;
  payload: ExactEvmPayload;
  extensions?: Record<string, unknown>;
}

export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  invalidMessage?: string;
  payer?: string;
}

export interface SettleResponse {
  success: boolean;
  errorReason?: string;
  errorMessage?: string;
  payer?: string;
  /** Transaction hash, or "" if nothing was broadcast. */
  transaction: string;
  network: string;
  amount?: string;
}

export function encodeHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

export function decodeHeader<T>(value: string): T {
  return JSON.parse(Buffer.from(value, "base64").toString("utf8")) as T;
}

export function caip2(chainId: number): string {
  return `eip155:${chainId}`;
}
