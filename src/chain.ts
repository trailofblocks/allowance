import { type ChildProcess, spawn } from "node:child_process";
import net from "node:net";
import {
  type Account,
  type Chain,
  createPublicClient,
  createTestClient,
  createWalletClient,
  type Hex,
  http,
  type PublicClient,
  type TestClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

/** Fixed genesis time, so every run sees the same block timestamps. */
export const GENESIS_TIMESTAMP = 1_750_000_000n;

export type Wallet = WalletClient<Transport, Chain, Account>;

const live = new Set<ChildProcess>();
process.on("exit", () => {
  for (const proc of live) proc.kill();
});

export function anvilBin(): string {
  return process.env.ANVIL_BIN || "anvil";
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForRpc(url: string, proc: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`anvil exited early with code ${proc.exitCode}`);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`anvil did not start within ${timeoutMs}ms`);
}

/**
 * A throwaway Anvil node on 127.0.0.1. Gas is free, so token balances measure only payments.
 * Each block is exactly one second after the previous one (unless time is moved on purpose),
 * which keeps spending windows, expiries, and the lab's numbers deterministic.
 */
export class LocalChain {
  readonly public: PublicClient<Transport, Chain>;
  readonly test: TestClient<"anvil", Transport, Chain>;

  private constructor(
    readonly url: string,
    private readonly proc: ChildProcess,
  ) {
    const transport = http(url, { timeout: 60_000, retryCount: 0 });
    this.public = createPublicClient({ chain: foundry, transport, pollingInterval: 10 });
    this.test = createTestClient({ chain: foundry, mode: "anvil", transport, pollingInterval: 10 });
  }

  static async start(): Promise<LocalChain> {
    const port = await freePort();
    const args = [
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--silent",
      "--chain-id",
      String(foundry.id),
      "--hardfork",
      "prague",
      "--base-fee",
      "0",
      "--gas-price",
      "0",
      "--timestamp",
      String(GENESIS_TIMESTAMP),
      "--accounts",
      "1",
    ];
    const proc = spawn(anvilBin(), args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    live.add(proc);
    proc.on("exit", () => live.delete(proc));
    proc.on("error", () => live.delete(proc));
    const url = `http://127.0.0.1:${port}`;
    try {
      await waitForRpc(url, proc, 20_000);
    } catch (err) {
      proc.kill();
      throw err;
    }
    const chain = new LocalChain(url, proc);
    await chain.test.setBlockTimestampInterval({ interval: 1 });
    return chain;
  }

  wallet(privateKey: Hex): Wallet {
    return createWalletClient({
      account: privateKeyToAccount(privateKey),
      chain: foundry,
      transport: http(this.url, { timeout: 60_000, retryCount: 0 }),
      pollingInterval: 10,
    });
  }

  /** Timestamp of the latest block. Agents and facilitators use chain time, not the wall clock. */
  async now(): Promise<bigint> {
    return (await this.public.getBlock({ blockTag: "latest" })).timestamp;
  }

  /** Move time forward; the next block is mined `seconds` later than it would have been. */
  async advance(seconds: bigint): Promise<void> {
    const now = await this.now();
    await this.test.setNextBlockTimestamp({ timestamp: now + seconds });
    await this.test.mine({ blocks: 1 });
  }

  async snapshot(): Promise<Hex> {
    return this.test.snapshot();
  }

  async revert(id: Hex): Promise<void> {
    await this.test.revert({ id });
  }

  async stop(): Promise<void> {
    if (this.proc.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      this.proc.once("exit", () => resolve());
      this.proc.kill();
      setTimeout(resolve, 3_000);
    });
  }
}
