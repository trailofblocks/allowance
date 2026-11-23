import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import type { Hex } from "viem";
import { eip3009TokenAbi } from "../src/abi.js";
import { localAddress, localKey, type LocalSetup, setupLocal, USDC } from "../src/local.js";
import { AllowanceBackend } from "../src/mcp/allowance-backend.js";
import { createPaymentsMcpServer } from "../src/mcp/server.js";
import { LocalFacilitator } from "../src/x402/facilitator.js";
import { PaidServer } from "../src/x402/server.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendor = localAddress("vendor");
const attacker = localAddress("attacker");
let s: LocalSetup;
let api: PaidServer;

const text = (r: Awaited<ReturnType<Client["callTool"]>>) =>
  (r.content as Array<{ type: string; text?: string }>).map((b) => b.text ?? "").join("\n");
const balance = (who: `0x${string}`) =>
  s.chain.public.readContract({ address: s.deployment.token, abi: eip3009TokenAbi, functionName: "balanceOf", args: [who] });

before(async () => {
  s = await setupLocal({ recipients: [vendor] });
  api = new PaidServer({
    facilitator: new LocalFacilitator(s.chain.public, s.facilitator),
    routes: { "/data": { body: "paid data", price: { amount: 2n * USDC, asset: s.deployment.token, payTo: vendor, name: "Mock USDC", version: "2" } } },
  });
  await api.start();
});

after(async () => {
  await api.stop();
  await s.chain.stop();
});

describe("in-process MCP server", () => {
  let client: Client;
  before(async () => {
    const backend = new AllowanceBackend(s.client(), { USDC: { address: s.deployment.token, decimals: 6 } }, s.chain.public.chain.id, () => s.chain.now());
    const server = createPaymentsMcpServer(backend);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    client = new Client({ name: "test", version: "0" });
    await client.connect(a);
  });
  after(async () => client.close());

  test("exposes four tools and no way to change the policy", async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["allowance_status", "fetch_paid", "pay", "payment_status"]);
  });

  test("status explains the budget", async () => {
    const r = await client.callTool({ name: "allowance_status", arguments: {} });
    assert.match(
      text(r),
      /USDC: 200 USDC left this period without approval, 1000 USDC left with approval; max 500 USDC per payment; a human co-signs any payment above 100 USDC/,
    );
  });

  test("pay, refuse, and queue", async () => {
    const ok = await client.callTool({ name: "pay", arguments: { to: vendor, amount: "12.5", token: "USDC", memo: "INV-1" } });
    assert.equal(ok.isError, undefined);
    assert.match(text(ok), /^Paid 12.5 USDC to 0x/);
    const no = await client.callTool({ name: "pay", arguments: { to: attacker, amount: "5", token: "USDC" } });
    assert.equal(no.isError, true);
    assert.match(text(no), /Not paid: recipient 0x[0-9a-fA-F]{40} is not on the account's allowlist/);
    const big = await client.callTool({ name: "pay", arguments: { to: vendor, amount: "150", token: "USDC" } });
    assert.match(text(big), /waiting for the account's human co-signer \(request 1\)/);
    const st = await client.callTool({ name: "payment_status", arguments: { id: "1" } });
    assert.match(text(st), /Request 1: pending/);
    assert.equal(await balance(vendor), 12_500_000n);
  });

  test("fetch_paid pays a 402 and returns the body", async () => {
    const r = await client.callTool({ name: "fetch_paid", arguments: { url: api.url("/data") } });
    assert.match(text(r), /Paid 2 USDC to 0x[0-9a-fA-F]{40} via x402/);
    assert.match(text(r), /paid data/);
  });

  test("fetch_paid honours a client-side ceiling", async () => {
    const r = await client.callTool({ name: "fetch_paid", arguments: { url: api.url("/data"), max_amount: "1" } });
    assert.equal(r.isError, true);
    assert.match(text(r), /above this request's ceiling/);
  });
});

describe("the CLI's stdio MCP server", () => {
  test("serves the same tools from a real process", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", path.join(root, "src", "cli.ts"), "mcp"],
      cwd: root,
      env: {
        ...getDefaultEnvironment(),
        ALLOWANCE_RPC_URL: s.chain.url,
        ALLOWANCE_MODULE: s.deployment.module,
        ALLOWANCE_ACCOUNT: s.account,
        ALLOWANCE_TOKENS: `USDC=${s.deployment.token}:6`,
        ALLOWANCE_AGENT_KEY: localKey("agent") as Hex,
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "test", version: "0" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      assert.equal(tools.length, 4);
      const before = await balance(vendor);
      const r = await client.callTool({ name: "pay", arguments: { to: vendor, amount: "1", token: "USDC" } });
      assert.match(text(r), /^Paid 1 USDC/);
      assert.equal((await balance(vendor)) - before, USDC);
    } finally {
      await client.close();
    }
  });
});
