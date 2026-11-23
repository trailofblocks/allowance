import {
  type Address,
  type Chain,
  getAddress,
  type Hex,
  hashTypedData,
  isAddressEqual,
  parseEventLogs,
  parseSignature,
  type PublicClient,
  recoverAddress,
  type Transport,
} from "viem";
import { eip3009TokenAbi } from "../abi.js";
import type { Wallet } from "../chain.js";
import { TRANSFER_WITH_AUTHORIZATION_TYPES } from "./signers.js";
import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from "./types.js";

const ERC1271_MAGIC = "0x1626ba7e";
const ERC1271_ABI = [
  {
    type: "function",
    name: "isValidSignature",
    stateMutability: "view",
    inputs: [
      { name: "hash", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ type: "bytes4" }],
  },
] as const;
const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/**
 * A local x402 facilitator for the `exact` scheme with EIP-3009, modelled on the verification steps in
 * the spec and in the official TypeScript facilitator (typescript/packages/mechanisms/evm/src/exact/
 * facilitator/eip3009.ts): a payer with no code must give a canonical 65-byte ECDSA signature; a payer
 * with code is checked with ERC-1271 at any signature length, and is settled through the token's
 * `bytes signature` overload. Time is chain time.
 */
export class LocalFacilitator {
  readonly network: string;
  /** Every settlement this facilitator made, for inspection. */
  readonly settled: Array<{ payer: Address; to: Address; value: bigint; transaction: Hex }> = [];

  constructor(
    private readonly pub: PublicClient<Transport, Chain>,
    private readonly wallet: Wallet,
  ) {
    this.network = `eip155:${pub.chain.id}`;
  }

  async verify(p: PaymentPayload, req: PaymentRequirements): Promise<VerifyResponse> {
    const a = p.payload?.authorization;
    const payer = a?.from;
    const fail = (invalidReason: string, invalidMessage?: string): VerifyResponse => ({
      isValid: false,
      invalidReason,
      invalidMessage,
      payer,
    });
    if (p.x402Version !== 2) return fail("invalid_x402_version");
    if (req.scheme !== "exact" || p.accepted?.scheme !== "exact") return fail("unsupported_scheme");
    if (req.network !== this.network || p.accepted.network !== this.network) return fail("invalid_network");
    if (!a || typeof p.payload.signature !== "string") return fail("invalid_payload");
    if (!req.extra?.name || !req.extra.version) return fail("invalid_payment_requirements", "extra.name and extra.version are required");
    if (!/^\d+$/.test(req.amount)) return fail("invalid_payment_requirements", "amount must be a decimal string");

    let from: Address, to: Address, asset: Address;
    try {
      from = getAddress(a.from);
      to = getAddress(a.to);
      asset = getAddress(req.asset);
    } catch {
      return fail("invalid_payload", "malformed address");
    }
    if (!isAddressEqual(to, getAddress(req.payTo))) return fail("invalid_exact_evm_payload_recipient_mismatch");
    if (BigInt(a.value) !== BigInt(req.amount)) return fail("invalid_exact_evm_payload_authorization_value_mismatch");

    const now = (await this.pub.getBlock({ blockTag: "latest" })).timestamp;
    if (BigInt(a.validBefore) < now + 6n) return fail("invalid_exact_evm_payload_authorization_valid_before");
    if (BigInt(a.validAfter) > now) return fail("invalid_exact_evm_payload_authorization_valid_after");

    const assetCode = await this.pub.getCode({ address: asset });
    if (!assetCode || assetCode === "0x") return fail("invalid_payment_requirements", "asset has no code");

    const hash = hashTypedData({
      domain: { name: req.extra.name, version: req.extra.version, chainId: this.pub.chain.id, verifyingContract: asset },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from,
        to,
        value: BigInt(a.value),
        validAfter: BigInt(a.validAfter),
        validBefore: BigInt(a.validBefore),
        nonce: a.nonce as Hex,
      },
    });
    const signature = p.payload.signature as Hex;
    const payerCode = await this.pub.getCode({ address: from });
    const sigOk = payerCode && payerCode !== "0x" ? await this.erc1271(from, hash, signature) : await this.ecdsa(from, hash, signature);
    if (!sigOk) return fail("invalid_exact_evm_payload_signature");

    const balance = await this.pub.readContract({ address: asset, abi: eip3009TokenAbi, functionName: "balanceOf", args: [from] });
    if (balance < BigInt(a.value)) return fail("insufficient_funds");

    try {
      await this.pub.simulateContract({ account: this.wallet.account, ...this.transferCall(asset, p) } as never);
    } catch (err) {
      return fail("invalid_transaction_state", (err as Error).message.split("\n")[0]);
    }
    return { isValid: true, payer: from };
  }

  async settle(p: PaymentPayload, req: PaymentRequirements): Promise<SettleResponse> {
    const v = await this.verify(p, req);
    if (!v.isValid) {
      return { success: false, errorReason: v.invalidReason, errorMessage: v.invalidMessage, payer: v.payer, transaction: "", network: this.network };
    }
    const asset = getAddress(req.asset);
    const a = p.payload.authorization;
    try {
      const hash = await this.wallet.writeContract({ ...this.transferCall(asset, p) } as never);
      const receipt = await this.pub.waitForTransactionReceipt({ hash });
      const moved = parseEventLogs({ abi: eip3009TokenAbi, logs: receipt.logs, eventName: "Transfer" }).some(
        (l) => isAddressEqual(l.args.from, getAddress(a.from)) && isAddressEqual(l.args.to, getAddress(a.to)) && l.args.value === BigInt(a.value),
      );
      if (receipt.status !== "success" || !moved) {
        return { success: false, errorReason: "unexpected_settle_error", payer: a.from, transaction: hash, network: this.network };
      }
      this.settled.push({ payer: getAddress(a.from), to: getAddress(a.to), value: BigInt(a.value), transaction: hash });
      return { success: true, payer: a.from, transaction: hash, network: this.network, amount: a.value };
    } catch (err) {
      return {
        success: false,
        errorReason: "unexpected_settle_error",
        errorMessage: (err as Error).message.split("\n")[0],
        payer: a.from,
        transaction: "",
        network: this.network,
      };
    }
  }

  /** 65-byte signatures go through the (v, r, s) overload; anything else through `bytes signature`. */
  private transferCall(asset: Address, p: PaymentPayload) {
    const a = p.payload.authorization;
    const base = [getAddress(a.from), getAddress(a.to), BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce as Hex] as const;
    const sig = p.payload.signature as Hex;
    if (sig.length === 132) {
      const { r, s, v, yParity } = parseSignature(sig);
      const vNum = v !== undefined ? Number(v) : yParity + 27;
      return {
        address: asset,
        abi: eip3009TokenAbi,
        functionName: "transferWithAuthorization" as const,
        args: [...base, vNum, r, s] as const,
      };
    }
    return {
      address: asset,
      abi: eip3009TokenAbi,
      functionName: "transferWithAuthorization" as const,
      args: [...base, sig] as const,
    };
  }

  private async erc1271(payer: Address, hash: Hex, signature: Hex): Promise<boolean> {
    try {
      const magic = await this.pub.readContract({ address: payer, abi: ERC1271_ABI, functionName: "isValidSignature", args: [hash, signature] });
      return magic.toLowerCase() === ERC1271_MAGIC;
    } catch {
      return false;
    }
  }

  private async ecdsa(payer: Address, hash: Hex, signature: Hex): Promise<boolean> {
    if (signature.length !== 132) return false;
    try {
      const { s } = parseSignature(signature);
      if (BigInt(s) > SECP256K1_HALF_N) return false;
      return isAddressEqual(await recoverAddress({ hash, signature }), payer);
    } catch {
      return false;
    }
  }
}
