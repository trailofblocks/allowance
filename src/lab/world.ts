import { McpServer } from "@modelcontextprotocol/server";
import { type Address, encodeFunctionData, type Hex, parseEther } from "viem";
import { z } from "zod";
import { allowanceModuleAbi, eip3009TokenAbi } from "../abi.js";
import type { Wallet } from "../chain.js";
import { mint, ownerCallsModule } from "../deploy.js";
import { DEFAULT_LIMITS, localKey, type LocalSetup, setupLocal, USDC } from "../local.js";
import type { TokenLimits } from "../policy.js";
import { LocalFacilitator } from "../x402/facilitator.js";
import { PaidServer } from "../x402/server.js";
import { ALLOWLIST, ATTACKER, ATTACKER2, DATACO } from "./fixtures.js";

export const FUNDING = 10_000n * USDC;

/** Everything a lab run needs: one chain, the account, a hot wallet for the baseline, and two web servers. */
export interface World {
  setup: LocalSetup;
  token: Address;
  module: Address;
  account: Address;
  hot: Wallet;
  facilitator: LocalFacilitator;
  /** DataCo's honest x402 API (payTo is allowlisted). */
  dataApi: PaidServer;
  /** The attacker's site: a paid API that pays the attacker, and free pages full of instructions. */
  evilSite: PaidServer;
  /** PAYMENT-SIGNATURE headers seen by DataCo's server, as a network eavesdropper would see them. */
  captured: string[];
  base: Hex;
}

export const priceFor = (w: World, payTo: Address, amount: bigint) => ({
  amount,
  asset: w.token,
  payTo,
  name: "Mock USDC",
  version: "2",
  maxTimeoutSeconds: 120,
});

export async function createWorld(): Promise<World> {
  const setup = await setupLocal({ recipients: ALLOWLIST, funding: FUNDING });
  const hot = setup.chain.wallet(localKey("hot-wallet"));
  await setup.chain.test.setBalance({ address: hot.account.address, value: parseEther("10") });
  await mint(setup.chain, setup.deployer, setup.deployment.token, hot.account.address, FUNDING);
  const facilitator = new LocalFacilitator(setup.chain.public, setup.facilitator);
  const captured: string[] = [];
  const dataApi = new PaidServer({ facilitator, routes: {}, onPaymentHeader: (h) => captured.push(h) });
  const evilSite = new PaidServer({ facilitator, routes: {} });
  await dataApi.start();
  await evilSite.start();
  const w: World = {
    setup,
    token: setup.deployment.token,
    module: setup.deployment.module,
    account: setup.account,
    hot,
    facilitator,
    dataApi,
    evilSite,
    captured,
    base: "0x",
  };
  w.base = await setup.chain.snapshot();
  return w;
}

export async function destroyWorld(w: World): Promise<void> {
  await w.dataApi.stop();
  await w.evilSite.stop();
  await w.setup.chain.stop();
}

/** Return to the freshly deployed state. */
export async function resetWorld(w: World): Promise<void> {
  await w.setup.chain.revert(w.base);
  w.base = await w.setup.chain.snapshot();
  w.captured.length = 0;
}

export async function balanceOf(w: World, who: Address): Promise<bigint> {
  return w.setup.chain.public.readContract({ address: w.token, abi: eip3009TokenAbi, functionName: "balanceOf", args: [who] });
}

/** The owner reconfigures its own policy (used by the ablation variants). */
export async function ownerSetLimits(w: World, limits: TokenLimits): Promise<void> {
  const data = encodeFunctionData({ abi: allowanceModuleAbi, functionName: "setTokenLimits", args: [w.token, limits] });
  await ownerCallsModule(w.setup.chain, w.setup.owner, w.module, data);
}

export async function ownerAllow(w: World, recipient: Address): Promise<void> {
  const data = encodeFunctionData({ abi: allowanceModuleAbi, functionName: "setRecipient", args: [recipient, true] });
  await ownerCallsModule(w.setup.chain, w.setup.owner, w.module, data);
}

/** Seconds until the current spending window ends, by the module's own clock. */
export async function secondsToWindowEnd(w: World): Promise<bigint> {
  const [, , ends] = await w.setup.chain.public.readContract({ address: w.module, abi: allowanceModuleAbi, functionName: "remaining", args: [w.account, w.token] });
  return BigInt(ends) - (await w.setup.chain.now());
}

/** An MCP server of documents and quotes: the places injected text arrives from. */
export function createDocsServer(docs: Record<string, string>, quotes: Record<string, string>): McpServer {
  const server = new McpServer({ name: "docs", version: "0.1.0" });
  server.registerTool(
    "read_document",
    { description: "Read a document from the shared inbox (invoices, notices, how-tos).", inputSchema: z.object({ id: z.string() }) },
    async ({ id }) => {
      const doc = docs[id];
      return doc ? { content: [{ type: "text" as const, text: doc }] } : { content: [{ type: "text" as const, text: `No document ${id}.` }], isError: true };
    },
  );
  server.registerTool(
    "get_quote",
    { description: "Get a supplier quote for an item.", inputSchema: z.object({ item: z.string() }) },
    async ({ item }) => {
      const q = quotes[item];
      return q ? { content: [{ type: "text" as const, text: q }] } : { content: [{ type: "text" as const, text: `No quote for ${item}.` }], isError: true };
    },
  );
  return server;
}

export const LAB_LIMITS = DEFAULT_LIMITS;
export { ATTACKER, ATTACKER2, DATACO };
