import { type Address, formatUnits, getAddress, isAddress, keccak256, parseUnits, toHex } from "viem";
import type { AllowanceClient } from "../client.js";
import { PolicyError } from "../policy.js";
import { x402Fetch } from "../x402/client.js";
import { AllowanceSigner } from "../x402/signers.js";
import { caip2 } from "../x402/types.js";
import type { PaymentsBackend, ToolOutcome } from "./server.js";

export interface TokenInfo {
  address: Address;
  decimals: number;
}

export const MAX_BODY_CHARS = 16_000;

export function memoRef(memo?: string) {
  return memo ? keccak256(toHex(memo)) : undefined;
}

/** Payments through the AllowanceModule. Every refusal carries the contract's reason. */
export class AllowanceBackend implements PaymentsBackend {
  constructor(
    private readonly client: AllowanceClient,
    private readonly tokens: Record<string, TokenInfo>,
    private readonly chainId: number,
    private readonly now: () => Promise<bigint>,
  ) {}

  private token(symbol: string): [string, TokenInfo] | undefined {
    const key = Object.keys(this.tokens).find((k) => k.toLowerCase() === symbol.toLowerCase());
    return key ? [key, this.tokens[key]!] : undefined;
  }

  private fmt(amount: bigint, address: string): string {
    const entry = Object.entries(this.tokens).find(([, t]) => t.address.toLowerCase() === address.toLowerCase());
    return entry ? `${formatUnits(amount, entry[1].decimals)} ${entry[0]}` : `${amount} units of ${address}`;
  }

  async status(): Promise<ToolOutcome> {
    const lines: string[] = [`Account ${this.client.account}, agent key ${this.client.agentAddress}.`];
    const data: Record<string, unknown> = {};
    for (const [symbol, t] of Object.entries(this.tokens)) {
      const s = await this.client.status(t.address);
      const f = (v: bigint) => `${formatUnits(v, t.decimals)} ${symbol}`;
      if (s.period === 0n) {
        lines.push(`${symbol}: not spendable (no limits configured).`);
        continue;
      }
      lines.push(
        `${symbol}: ${f(s.autoLeft)} left this period without approval, ${f(s.hardLeft)} left with approval; ` +
          `max ${f(s.maxPerTx)} per payment; a human co-signs any payment above ${f(s.cosignAbove)}; ` +
          `period resets at ${new Date(Number(s.windowEnds) * 1000).toISOString()}.${s.paused ? " PAUSED." : ""}`,
      );
      data[symbol] = {
        autoLeft: s.autoLeft.toString(),
        hardLeft: s.hardLeft.toString(),
        maxPerTx: s.maxPerTx.toString(),
        cosignAbove: s.cosignAbove.toString(),
        windowEnds: s.windowEnds.toString(),
        paused: s.paused,
      };
    }
    return { ok: true, text: lines.join("\n"), data };
  }

  async pay(args: { to: string; amount: string; token: string; memo?: string }): Promise<ToolOutcome> {
    const tok = this.token(args.token);
    if (!tok) return { ok: false, text: `Unknown token ${args.token}. Known: ${Object.keys(this.tokens).join(", ")}.` };
    if (!isAddress(args.to)) return { ok: false, text: `"${args.to}" is not an address.` };
    let amount: bigint;
    try {
      amount = parseUnits(args.amount, tok[1].decimals);
    } catch {
      return { ok: false, text: `"${args.amount}" is not an amount.` };
    }
    const label = `${args.amount} ${tok[0]} to ${getAddress(args.to)}`;
    try {
      const res = await this.client.pay(tok[1].address, getAddress(args.to), amount, memoRef(args.memo));
      if (res.status === "paid") {
        return { ok: true, text: `Paid ${label}${res.pendingId ? " after co-signer approval" : ""} (tx ${res.txHash}).`, data: { status: "paid", tx: res.txHash } };
      }
      const id = res.pendingId.toString();
      const verb = { pending: "is waiting for the account's human co-signer", rejected: "was rejected by the co-signer", expired: "expired before approval" }[res.status];
      return { ok: res.status === "pending", text: `Payment of ${label} ${verb} (request ${id}).`, data: { status: res.status, id } };
    } catch (err) {
      if (err instanceof PolicyError) return { ok: false, text: `Not paid: ${err.message}.`, data: { status: "refused", code: err.code } };
      throw err;
    }
  }

  async fetchPaid(args: { url: string; maxAmount?: string }): Promise<ToolOutcome> {
    let maxAmount: bigint | undefined;
    if (args.maxAmount) {
      const usdc = Object.values(this.tokens)[0];
      maxAmount = usdc ? parseUnits(args.maxAmount, usdc.decimals) : undefined;
    }
    const out = await x402Fetch(args.url, {
      signer: new AllowanceSigner(this.client),
      network: caip2(this.chainId),
      now: this.now,
      maxAmount,
    });
    switch (out.status) {
      case "free":
      case "paid": {
        const body = (await out.response.text()).slice(0, MAX_BODY_CHARS);
        const paid =
          out.status === "paid"
            ? `Paid ${this.fmt(BigInt(out.requirement.amount), out.requirement.asset)} to ${out.requirement.payTo} via x402 (tx ${out.settlement?.transaction ?? "?"}).\n`
            : "";
        return {
          ok: out.response.ok,
          text: `${paid}HTTP ${out.response.status} from ${args.url}:\n${body}`,
          data: { status: out.status, http: out.response.status },
        };
      }
      case "pending":
      case "rejected":
      case "expired":
        return {
          ok: out.status === "pending",
          text:
            `x402 payment of ${this.fmt(BigInt(out.requirement.amount), out.requirement.asset)} to ${out.requirement.payTo} ` +
            `${out.status === "pending" ? "is waiting for the account's human co-signer" : `was ${out.status}`} (request ${out.pendingId}).`,
          data: { status: out.status, id: out.pendingId.toString() },
        };
      case "refused":
        return { ok: false, text: `Not paid: ${out.reason}.`, data: { status: "refused", code: out.code } };
    }
  }

  async paymentStatus(args: { id: string }): Promise<ToolOutcome> {
    if (!/^\d+$/.test(args.id)) return { ok: false, text: `"${args.id}" is not a request id.` };
    const state = await this.client.requestState(BigInt(args.id));
    return { ok: true, text: `Request ${args.id}: ${state}.`, data: { status: state } };
  }
}
