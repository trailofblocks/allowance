import { type Address, formatUnits, getAddress, isAddress, parseUnits } from "viem";
import { eip3009TokenAbi } from "../abi.js";
import type { LocalChain, Wallet } from "../chain.js";
import type { TokenInfo } from "../mcp/allowance-backend.js";
import { MAX_BODY_CHARS } from "../mcp/allowance-backend.js";
import type { PaymentsBackend, ToolOutcome } from "../mcp/server.js";
import { x402Fetch } from "../x402/client.js";
import { EoaSigner } from "../x402/signers.js";
import { caip2 } from "../x402/types.js";

/**
 * The baseline: the same four tools, paying from an ordinary hot wallet whose key the agent holds.
 * This is how many agent payment setups work today. There is no policy, so whatever the agent is
 * talked into, it does.
 */
export class HotWalletBackend implements PaymentsBackend {
  constructor(
    private readonly chain: LocalChain,
    private readonly wallet: Wallet,
    private readonly tokens: Record<string, TokenInfo>,
  ) {}

  async status(): Promise<ToolOutcome> {
    const lines = [`Hot wallet ${this.wallet.account.address}.`];
    for (const [symbol, t] of Object.entries(this.tokens)) {
      const bal = await this.chain.public.readContract({ address: t.address, abi: eip3009TokenAbi, functionName: "balanceOf", args: [this.wallet.account.address] });
      lines.push(`${symbol}: balance ${formatUnits(bal, t.decimals)}. No limits.`);
    }
    return { ok: true, text: lines.join("\n") };
  }

  async pay(args: { to: string; amount: string; token: string; memo?: string }): Promise<ToolOutcome> {
    const key = Object.keys(this.tokens).find((k) => k.toLowerCase() === args.token.toLowerCase());
    if (!key) return { ok: false, text: `Unknown token ${args.token}.` };
    if (!isAddress(args.to)) return { ok: false, text: `"${args.to}" is not an address.` };
    const t = this.tokens[key]!;
    let amount: bigint;
    try {
      amount = parseUnits(args.amount, t.decimals);
    } catch {
      return { ok: false, text: `"${args.amount}" is not an amount.` };
    }
    try {
      const hash = await this.wallet.writeContract({ address: t.address, abi: eip3009TokenAbi, functionName: "transfer", args: [getAddress(args.to) as Address, amount] });
      const receipt = await this.chain.public.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") return { ok: false, text: `Transfer reverted (tx ${hash}).` };
      return { ok: true, text: `Paid ${args.amount} ${key} to ${getAddress(args.to)} (tx ${hash}).`, data: { status: "paid", tx: hash } };
    } catch (err) {
      return { ok: false, text: `Not paid: ${(err as Error).message.split("\n")[0]}` };
    }
  }

  async fetchPaid(args: { url: string; maxAmount?: string }): Promise<ToolOutcome> {
    const out = await x402Fetch(args.url, {
      signer: new EoaSigner(this.wallet, this.chain.public.chain.id),
      network: caip2(this.chain.public.chain.id),
      now: () => this.chain.now(),
    });
    if (out.status === "free" || out.status === "paid") {
      const body = (await out.response.text()).slice(0, MAX_BODY_CHARS);
      const paid = out.status === "paid" ? `Paid ${out.requirement.amount} units to ${out.requirement.payTo} via x402.\n` : "";
      return { ok: out.response.ok, text: `${paid}HTTP ${out.response.status} from ${args.url}:\n${body}` };
    }
    if (out.status === "refused") return { ok: false, text: `Not paid: ${out.reason}.` };
    return { ok: false, text: `Unexpected state ${out.status}.` };
  }

  async paymentStatus(): Promise<ToolOutcome> {
    return { ok: true, text: "A hot wallet never queues payments." };
  }
}
