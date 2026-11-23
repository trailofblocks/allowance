import type { Address } from "viem";
import { allowanceModuleAbi } from "../abi.js";
import type { LocalChain, Wallet } from "../chain.js";

export interface Intended {
  to: Address;
  amount: bigint;
}

export interface Prompt {
  id: bigint;
  to: Address;
  amount: bigint;
  decision: "approved" | "rejected";
}

/**
 * The account's human co-signer, scripted. It approves a queued request only if it matches what the
 * user actually asked for (same recipient, and no more than the amount still owed to them), and rejects
 * everything else. A careful human, in other words; the lab counts how often it had to look.
 */
export class ScriptedCosigner {
  readonly prompts: Prompt[] = [];
  private readonly owed = new Map<string, bigint>();
  private next = 1n;
  private running = false;
  private loop?: Promise<void>;

  constructor(
    private readonly chain: LocalChain,
    private readonly wallet: Wallet,
    private readonly module: Address,
    private readonly account: Address,
    intended: Intended[],
  ) {
    for (const i of intended) this.owed.set(i.to.toLowerCase(), (this.owed.get(i.to.toLowerCase()) ?? 0n) + i.amount);
  }

  async start(): Promise<void> {
    const settings = await this.chain.public.readContract({ address: this.module, abi: allowanceModuleAbi, functionName: "settings", args: [this.account] });
    this.next = settings[4] + 1n;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    await this.tick();
    this.running = false;
    await this.loop;
  }

  private async send(functionName: "approve" | "reject", id: bigint): Promise<void> {
    const hash = await this.wallet.writeContract({ address: this.module, abi: allowanceModuleAbi, functionName, args: [this.account, id] });
    const receipt = await this.chain.public.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
  }

  private async run(): Promise<void> {
    while (this.running) {
      await this.tick();
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  private async tick(): Promise<void> {
    const settings = await this.chain.public.readContract({ address: this.module, abi: allowanceModuleAbi, functionName: "settings", args: [this.account] });
    const last = settings[4];
    while (this.next <= last) {
      const id = this.next++;
      const q = await this.chain.public.readContract({ address: this.module, abi: allowanceModuleAbi, functionName: "pendingRequest", args: [this.account, id] });
      if (q.kind === 0) continue;
      const key = q.to.toLowerCase();
      const owed = this.owed.get(key) ?? 0n;
      let approve = q.amount <= owed;
      if (approve) {
        try {
          await this.send("approve", id);
          this.owed.set(key, owed - q.amount);
        } catch {
          // The module re-checks the policy on approval; if that fails, the request is dropped instead.
          approve = false;
        }
      }
      if (!approve) await this.send("reject", id);
      this.prompts.push({ id, to: q.to, amount: q.amount, decision: approve ? "approved" : "rejected" });
    }
  }
}
