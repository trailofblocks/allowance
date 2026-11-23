import { type Address, getAddress, type Hex, toHex } from "viem";
import { randomBytes } from "node:crypto";
import type { AllowanceClient } from "../client.js";
import type { Wallet } from "../chain.js";
import type { ExactEvmPayload, PaymentRequirements } from "./types.js";

export type AuthorizeResult =
  | { status: "ready"; payload: ExactEvmPayload }
  | { status: "pending" | "rejected" | "expired"; pendingId: bigint }
  | { status: "refused"; reason: string; code?: string };

/** Produces the `payload` of an x402 `exact` EIP-3009 payment. */
export interface PaymentSigner {
  readonly payer: Address;
  authorize(req: PaymentRequirements, now: bigint): Promise<AuthorizeResult>;
}

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** x402 clients commonly backdate validAfter by ten minutes to absorb clock skew. */
const VALID_AFTER_SKEW = 600n;

function window(req: PaymentRequirements, now: bigint, cap: bigint) {
  const timeout = BigInt(Math.max(1, Math.floor(req.maxTimeoutSeconds || 60)));
  const ttl = timeout < cap ? timeout : cap;
  return { validAfter: now > VALID_AFTER_SKEW ? now - VALID_AFTER_SKEW : 0n, validBefore: now + ttl };
}

const randomNonce = (): Hex => toHex(randomBytes(32));

/**
 * Pays from a smart account through the AllowanceModule. The module runs the policy and records the
 * authorization; the "signature" is just the module's address, which routes the token's ERC-1271
 * check to the module. Nothing the agent holds can sign for the account.
 */
export class AllowanceSigner implements PaymentSigner {
  readonly payer: Address;
  constructor(private readonly client: AllowanceClient) {
    this.payer = client.account;
  }

  async authorize(req: PaymentRequirements, now: bigint): Promise<AuthorizeResult> {
    // Leave a few seconds of slack under the module's cap on authorization lifetimes.
    const cap = (await this.client.maxAuthWindow()) - 5n;
    const { validAfter, validBefore } = window(req, now, cap);
    const auth = {
      token: getAddress(req.asset),
      to: getAddress(req.payTo),
      value: BigInt(req.amount),
      validAfter,
      validBefore,
      nonce: randomNonce(),
    };
    const res = await this.client.reserve(auth);
    if (res.status !== "reserved") return { status: res.status, pendingId: res.pendingId };
    return {
      status: "ready",
      payload: {
        signature: this.client.module.toLowerCase(),
        authorization: {
          from: this.payer,
          to: auth.to,
          value: auth.value.toString(),
          validAfter: auth.validAfter.toString(),
          validBefore: auth.validBefore.toString(),
          nonce: auth.nonce,
        },
      },
    };
  }
}

/** Pays from a plain EOA by signing EIP-3009 typed data with its key. No policy at all. */
export class EoaSigner implements PaymentSigner {
  readonly payer: Address;
  constructor(
    private readonly wallet: Wallet,
    private readonly chainId: number,
  ) {
    this.payer = wallet.account.address;
  }

  async authorize(req: PaymentRequirements, now: bigint): Promise<AuthorizeResult> {
    if (!req.extra?.name || !req.extra.version) return { status: "refused", reason: "missing EIP-712 domain in extra" };
    const { validAfter, validBefore } = window(req, now, 3600n);
    const message = {
      from: this.payer,
      to: getAddress(req.payTo),
      value: BigInt(req.amount),
      validAfter,
      validBefore,
      nonce: randomNonce(),
    };
    const signature = await this.wallet.signTypedData({
      domain: { name: req.extra.name, version: req.extra.version, chainId: this.chainId, verifyingContract: getAddress(req.asset) },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message,
    });
    return {
      status: "ready",
      payload: {
        signature,
        authorization: {
          from: message.from,
          to: message.to,
          value: message.value.toString(),
          validAfter: message.validAfter.toString(),
          validBefore: message.validBefore.toString(),
          nonce: message.nonce,
        },
      },
    };
  }
}
