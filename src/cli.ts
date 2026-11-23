#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { Command } from "commander";
import { type Address, createPublicClient, createWalletClient, defineChain, getAddress, type Hex, http, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { allowanceModuleAbi } from "./abi.js";
import { AllowanceClient } from "./client.js";
import { localKey, setupLocal, USDC } from "./local.js";
import { parseTokens } from "./config.js";
import { AllowanceBackend } from "./mcp/allowance-backend.js";
import { createPaymentsMcpServer } from "./mcp/server.js";
import { renderReport } from "./lab/report.js";
import { runLab, type VariantId } from "./lab/runner.js";
import { LocalFacilitator } from "./x402/facilitator.js";
import { PaidServer } from "./x402/server.js";

const program = new Command();
program
  .name("allowance")
  .description("Spending limits an AI agent can't talk its way past: an ERC-7579 policy module, an MCP server, and a red-team lab.")
  .version("0.1.0");

program
  .command("lab")
  .description("Run the prompt-injection red-team lab on a local Anvil chain. No model, no network, no real funds.")
  .option("--ablation", "also run each attack against single policy layers")
  .option("--only <ids>", "comma-separated scenario ids, e.g. R1,R5,B2")
  .option("--json", "print raw results as JSON")
  .option("--verbose", "print what the compromised key tried in R7 and R8")
  .action(async (opts: { ablation?: boolean; only?: string; json?: boolean; verbose?: boolean }) => {
    const variants: VariantId[] = opts.ablation
      ? ["baseline", "allowance", "allowlist-only", "limits-only", "cosigner-only", "no-window-budget"]
      : ["baseline", "allowance"];
    const results = await runLab({ variants, scenarios: opts.only?.split(",").map((s) => s.trim()) });
    if (opts.json) {
      console.log(JSON.stringify(results, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    } else {
      console.log(renderReport(results));
      if (opts.verbose) {
        for (const r of results.filter((x) => x.keyLevel.length && x.variant === "allowance")) {
          console.log(`\n${r.scenario}, key-level attempts against allowance:`);
          for (const n of r.keyLevel) console.log(`  - ${n}`);
        }
      }
    }
    const bad = results.filter((r) => r.variant === "allowance" && (r.scenario.startsWith("R") ? !r.held : !r.completed));
    if (bad.length) {
      console.error(`\n${bad.length} scenario(s) not held or not completed under allowance: ${bad.map((r) => r.scenario).join(", ")}`);
      process.exitCode = 1;
    }
  });

function env(name: string, flag?: string): string {
  const v = flag ?? process.env[name];
  if (!v) throw new Error(`set ${name} (or pass the matching flag)`);
  return v;
}

async function chainFor(rpc: string) {
  const res = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
  const id = Number.parseInt(((await res.json()) as { result: string }).result, 16);
  return defineChain({ id, name: `chain-${id}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
}

program
  .command("mcp")
  .description("Serve the agent's payment tools over MCP (stdio). The agent key comes from ALLOWANCE_AGENT_KEY.")
  .option("--rpc <url>", "JSON-RPC URL (ALLOWANCE_RPC_URL)")
  .option("--module <address>", "AllowanceModule address (ALLOWANCE_MODULE)")
  .option("--account <address>", "the smart account (ALLOWANCE_ACCOUNT)")
  .option("--tokens <spec>", "SYMBOL=0xADDRESS:DECIMALS,... (ALLOWANCE_TOKENS)")
  .option("--approval-wait <ms>", "how long pay waits for the co-signer before answering 'pending' (ALLOWANCE_APPROVAL_WAIT_MS)")
  .action(async (opts: { rpc?: string; module?: string; account?: string; tokens?: string; approvalWait?: string }) => {
    const rpc = env("ALLOWANCE_RPC_URL", opts.rpc);
    const module = env("ALLOWANCE_MODULE", opts.module);
    const account = env("ALLOWANCE_ACCOUNT", opts.account);
    if (!isAddress(module) || !isAddress(account)) throw new Error("module and account must be addresses");
    const key = env("ALLOWANCE_AGENT_KEY") as Hex;
    const chain = await chainFor(rpc);
    const transport = http(rpc);
    const publicClient = createPublicClient({ chain, transport });
    const agent = createWalletClient({ account: privateKeyToAccount(key), chain, transport });
    const tokens = parseTokens(env("ALLOWANCE_TOKENS", opts.tokens));
    const client = new AllowanceClient({
      publicClient,
      agent,
      module: getAddress(module),
      account: getAddress(account),
      approvalWaitMs: Number(opts.approvalWait ?? process.env.ALLOWANCE_APPROVAL_WAIT_MS ?? 0),
      units: (t) => {
        const e = Object.entries(tokens).find(([, i]) => i.address.toLowerCase() === t.toLowerCase());
        return e ? { symbol: e[0], decimals: e[1].decimals } : undefined;
      },
    });
    const backend = new AllowanceBackend(client, tokens, chain.id, async () => (await publicClient.getBlock({ blockTag: "latest" })).timestamp);
    const server = createPaymentsMcpServer(backend);
    await server.connect(new StdioServerTransport());
  });

program
  .command("local")
  .description("Start Anvil, deploy everything, upgrade a local EOA with EIP-7702, and serve a paid demo API. Ctrl-C stops it.")
  .option("--recipient <address...>", "allowlisted recipients (default: the demo API's payTo)")
  .action(async (opts: { recipient?: string[] }) => {
    const demoPayTo = privateKeyToAccount(localKey("dataco-api")).address;
    const recipients = (opts.recipient ?? [demoPayTo]).map((a) => getAddress(a));
    const s = await setupLocal({ recipients });
    const facilitator = new LocalFacilitator(s.chain.public, s.facilitator);
    const api = new PaidServer({
      facilitator,
      routes: {
        "/forecast": {
          body: "Berlin, 7 days: 12C, light rain Tue-Wed, clear from Thursday.",
          price: { amount: USDC / 20n, asset: s.deployment.token, payTo: demoPayTo, name: "Mock USDC", version: "2" },
        },
        "/report": {
          body: "Q4 market report.",
          price: { amount: 150n * USDC, asset: s.deployment.token, payTo: demoPayTo, name: "Mock USDC", version: "2" },
        },
      },
    });
    await api.start();
    console.log("Local chain ready. Everything below is local-only test data; these keys hold nothing real.\n");
    console.log(`ALLOWANCE_RPC_URL=${s.chain.url}`);
    console.log(`ALLOWANCE_MODULE=${s.deployment.module}`);
    console.log(`ALLOWANCE_ACCOUNT=${s.account}`);
    console.log(`ALLOWANCE_TOKENS=USDC=${s.deployment.token}:6`);
    console.log(`ALLOWANCE_AGENT_KEY=${localKey("agent")}`);
    console.log(`ALLOWANCE_COSIGNER_KEY=${localKey("cosigner")}`);
    console.log(`\nPaid demo API (x402): ${api.url("/forecast")} (0.05 USDC), ${api.url("/report")} (150 USDC, needs the co-signer)`);
    console.log(`Allowlisted: ${recipients.join(", ")}. Limits: 500 per payment, co-sign above 100, 200/day alone, 1,000/day hard.`);
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
    await api.stop();
    await s.chain.stop();
  });

program
  .command("cosign")
  .description("Act as the account's co-signer: approve, reject, or pause. The key comes from ALLOWANCE_COSIGNER_KEY.")
  .argument("<action>", "approve | reject | pause")
  .argument("[id]", "request id (approve, reject)")
  .option("--rpc <url>", "JSON-RPC URL (ALLOWANCE_RPC_URL)")
  .option("--module <address>", "AllowanceModule address (ALLOWANCE_MODULE)")
  .option("--account <address>", "the smart account (ALLOWANCE_ACCOUNT)")
  .action(async (action: string, id: string | undefined, opts: { rpc?: string; module?: string; account?: string }) => {
    const rpc = env("ALLOWANCE_RPC_URL", opts.rpc);
    const module = getAddress(env("ALLOWANCE_MODULE", opts.module)) as Address;
    const account = getAddress(env("ALLOWANCE_ACCOUNT", opts.account)) as Address;
    const chain = await chainFor(rpc);
    const wallet = createWalletClient({ account: privateKeyToAccount(env("ALLOWANCE_COSIGNER_KEY") as Hex), chain, transport: http(rpc) });
    const pub = createPublicClient({ chain, transport: http(rpc) });
    let hash: Hex;
    if (action === "pause") {
      hash = await wallet.writeContract({ address: module, abi: allowanceModuleAbi, functionName: "pause", args: [account] });
    } else if ((action === "approve" || action === "reject") && id && /^\d+$/.test(id)) {
      const q = await pub.readContract({ address: module, abi: allowanceModuleAbi, functionName: "pendingRequest", args: [account, BigInt(id)] });
      console.log(`Request ${id}: ${q.kind === 1 ? "transfer" : q.kind === 2 ? "x402 authorization" : "none"} of ${q.amount} units of ${q.token} to ${q.to}`);
      hash = await wallet.writeContract({ address: module, abi: allowanceModuleAbi, functionName: action, args: [account, BigInt(id)] });
    } else {
      throw new Error("usage: allowance cosign approve|reject <id> | allowance cosign pause");
    }
    const receipt = await pub.waitForTransactionReceipt({ hash });
    console.log(`${action}: ${receipt.status} (tx ${hash})`);
  });

program.parseAsync().catch((err: unknown) => {
  console.error(`allowance: ${(err as Error).message}`);
  process.exit(1);
});
