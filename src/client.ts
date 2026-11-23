import { type Address, type Chain, type Hex, type PublicClient, parseEventLogs, type Transport } from "viem";
import { allowanceModuleAbi } from "./abi.js";
import type { Wallet } from "./chain.js";
import { asPolicyError, PolicyError, type Units } from "./policy.js";

export interface AllowanceClientOptions {
  publicClient: PublicClient<Transport, Chain>;
  /** A wallet holding the agent's key. The key is registered with the module, not an owner of the account. */
  agent: Wallet;
  module: Address;
  /** The smart account (for EIP-7702, the owner's EOA address). */
  account: Address;
  /** How long `pay` and `reserve` wait for the co-signer before returning "pending". Default 0. */
  approvalWaitMs?: number;
  pollMs?: number;
  /** Token display info, used in error messages. */
  units?: (token: Address) => Units | undefined;
}

export interface Status {
  token: Address;
  autoLeft: bigint;
  hardLeft: bigint;
  windowEnds: bigint;
  maxPerTx: bigint;
  cosignAbove: bigint;
  autoPerPeriod: bigint;
  maxPerPeriod: bigint;
  period: bigint;
  paused: boolean;
  cosigner: Address;
}

export type RequestState = "pending" | "approved" | "rejected" | "expired" | "unknown";

export type PayResult =
  | { status: "paid"; txHash: Hex; pendingId?: bigint }
  | { status: "pending" | "rejected" | "expired"; pendingId: bigint; txHash: Hex };

export interface Authorization {
  token: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
}

export type ReserveResult =
  | { status: "reserved"; digest: Hex; txHash: Hex; pendingId?: bigint }
  | { status: "pending" | "rejected" | "expired"; digest: Hex; pendingId: bigint; txHash: Hex };

const KIND_NONE = 0;

/**
 * The agent's side of the module. Every call is checked by the contract; this client only adds a
 * dry run first, so a refusal comes back as a readable {@link PolicyError} without spending gas.
 */
export class AllowanceClient {
  readonly module: Address;
  readonly account: Address;
  private readonly pub: PublicClient<Transport, Chain>;
  private readonly agent: Wallet;

  constructor(private readonly opts: AllowanceClientOptions) {
    this.module = opts.module;
    this.account = opts.account;
    this.pub = opts.publicClient;
    this.agent = opts.agent;
  }

  get agentAddress(): Address {
    return this.agent.account.address;
  }

  async status(token: Address): Promise<Status> {
    const [rem, policy, settings] = await Promise.all([
      this.read("remaining", [this.account, token]),
      this.read("tokenPolicy", [this.account, token]),
      this.read("settings", [this.account]),
    ]);
    const [autoLeft, hardLeft, windowEnds] = rem as readonly [bigint, bigint, bigint];
    const p = policy as { maxPerTx: bigint; cosignAbove: bigint; autoPerPeriod: bigint; maxPerPeriod: bigint; period: bigint };
    const [cosigner, paused] = settings as readonly [Address, boolean, number, number, bigint];
    return {
      token,
      autoLeft,
      hardLeft,
      windowEnds: BigInt(windowEnds),
      maxPerTx: p.maxPerTx,
      cosignAbove: p.cosignAbove,
      autoPerPeriod: p.autoPerPeriod,
      maxPerPeriod: p.maxPerPeriod,
      period: BigInt(p.period),
      paused,
      cosigner,
    };
  }

  async maxAuthWindow(): Promise<bigint> {
    const settings = (await this.read("settings", [this.account])) as readonly [Address, boolean, number, number, bigint];
    return BigInt(settings[3] || 3600);
  }

  /** Pay `amount` (atomic units) of `token` to `to`. Throws PolicyError if the policy refuses it. */
  async pay(token: Address, to: Address, amount: bigint, ref: Hex = ZERO32): Promise<PayResult> {
    const txHash = await this.send("pay", [this.account, token, to, amount, ref], token);
    const receipt = await this.pub.waitForTransactionReceipt({ hash: txHash });
    const logs = parseEventLogs({ abi: allowanceModuleAbi, logs: receipt.logs });
    if (logs.some((l) => l.eventName === "Paid")) return { status: "paid", txHash };
    const queued = logs.find((l) => l.eventName === "Queued");
    if (!queued) throw new Error(`pay transaction ${txHash} emitted neither Paid nor Queued`);
    const pendingId = (queued.args as { id: bigint }).id;
    const state = await this.waitForDecision(pendingId);
    if (state === "approved") return { status: "paid", txHash, pendingId };
    return { status: state === "rejected" || state === "expired" ? state : "pending", pendingId, txHash };
  }

  /** Reserve an EIP-3009 authorization from the account. Throws PolicyError if the policy refuses it. */
  async reserve(a: Authorization, ref: Hex = ZERO32): Promise<ReserveResult> {
    const digest = (await this.read("authorizationDigest", [
      this.account,
      a.token,
      a.to,
      a.value,
      a.validAfter,
      a.validBefore,
      a.nonce,
    ])) as Hex;
    const txHash = await this.send("reserve", [this.account, a, ref], a.token);
    const receipt = await this.pub.waitForTransactionReceipt({ hash: txHash });
    const logs = parseEventLogs({ abi: allowanceModuleAbi, logs: receipt.logs });
    if (logs.some((l) => l.eventName === "Reserved")) return { status: "reserved", digest, txHash };
    const queued = logs.find((l) => l.eventName === "Queued");
    if (!queued) throw new Error(`reserve transaction ${txHash} emitted neither Reserved nor Queued`);
    const pendingId = (queued.args as { id: bigint }).id;
    const state = await this.waitForDecision(pendingId);
    if (state === "approved") return { status: "reserved", digest, txHash, pendingId };
    return { status: state === "rejected" || state === "expired" ? state : "pending", digest, pendingId, txHash };
  }

  /** Where a queued request stands. */
  async requestState(id: bigint): Promise<RequestState> {
    const q = (await this.read("pendingRequest", [this.account, id])) as { kind: number; expiresAt: bigint };
    if (q.kind !== KIND_NONE) {
      const now = (await this.pub.getBlock({ blockTag: "latest" })).timestamp;
      return now >= BigInt(q.expiresAt) ? "expired" : "pending";
    }
    const [approved, rejected] = await Promise.all([
      this.pub.getContractEvents({
        address: this.module,
        abi: allowanceModuleAbi,
        eventName: "Approved",
        args: { account: this.account, id },
        fromBlock: 0n,
      }),
      this.pub.getContractEvents({
        address: this.module,
        abi: allowanceModuleAbi,
        eventName: "Rejected",
        args: { account: this.account, id },
        fromBlock: 0n,
      }),
    ]);
    if (approved.length > 0) return "approved";
    if (rejected.length > 0) return "rejected";
    return "unknown";
  }

  private async waitForDecision(id: bigint): Promise<RequestState> {
    const wait = this.opts.approvalWaitMs ?? 0;
    const poll = this.opts.pollMs ?? 1000;
    const deadline = Date.now() + wait;
    for (;;) {
      const state = await this.requestState(id);
      if (state !== "pending" || Date.now() >= deadline) return state;
      await new Promise((r) => setTimeout(r, poll));
    }
  }

  private read(functionName: string, args: unknown[]): Promise<unknown> {
    return this.pub.readContract({ address: this.module, abi: allowanceModuleAbi, functionName: functionName as never, args: args as never });
  }

  /** Dry-run, then send. A refusal surfaces as a PolicyError before anything is broadcast. */
  private async send(functionName: "pay" | "reserve", args: unknown[], token: Address): Promise<Hex> {
    try {
      const { request } = await this.pub.simulateContract({
        account: this.agent.account,
        address: this.module,
        abi: allowanceModuleAbi,
        functionName,
        args: args as never,
      });
      return await this.agent.writeContract(request as never);
    } catch (err) {
      const policy = asPolicyError(err, this.opts.units?.(token));
      if (policy) throw policy;
      throw err;
    }
  }
}

export const ZERO32: Hex = `0x${"00".repeat(32)}`;
export { PolicyError };
