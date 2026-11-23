import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

/** What a payment tool call produced, in words for the model plus structured data for callers. */
export interface ToolOutcome {
  ok: boolean;
  text: string;
  data?: Record<string, unknown>;
}

/**
 * The payment capabilities an agent gets. The allowance backend runs every payment through the
 * on-chain module; the lab's baseline backend pays from a plain hot wallet with the same tools.
 */
export interface PaymentsBackend {
  status(): Promise<ToolOutcome>;
  pay(args: { to: string; amount: string; token: string; memo?: string }): Promise<ToolOutcome>;
  fetchPaid(args: { url: string; maxAmount?: string }): Promise<ToolOutcome>;
  paymentStatus(args: { id: string }): Promise<ToolOutcome>;
}

const result = (o: ToolOutcome) => ({
  content: [{ type: "text" as const, text: o.text }],
  ...(o.data ? { structuredContent: o.data } : {}),
  ...(o.ok ? {} : { isError: true }),
});

/**
 * An MCP server with four tools. There is deliberately no tool that changes limits, recipients, or
 * keys: those belong to the account owner, and the agent's key can't change them on-chain either.
 */
export function createPaymentsMcpServer(backend: PaymentsBackend, name = "allowance"): McpServer {
  const server = new McpServer({ name, version: "0.1.0" });

  server.registerTool(
    "allowance_status",
    {
      description:
        "Show what this agent may still spend: remaining budget for the current period, the per-payment limit, " +
        "the amount above which a human must co-sign, and whether payments are paused.",
      inputSchema: z.object({}),
    },
    async () => result(await backend.status()),
  );

  server.registerTool(
    "pay",
    {
      description:
        "Pay an allowlisted recipient. Amount is in whole token units as a decimal string (\"12.50\"). " +
        "Large payments wait for the account's human co-signer; payments outside the policy are refused with the reason.",
      inputSchema: z.object({
        to: z.string().describe("Recipient address (0x...)"),
        amount: z.string().describe("Amount in token units, e.g. \"12.50\""),
        token: z.string().default("USDC").describe("Token symbol"),
        memo: z.string().optional().describe("Invoice number or note, recorded on-chain as a hash"),
      }),
    },
    async (args) => result(await backend.pay(args)),
  );

  server.registerTool(
    "fetch_paid",
    {
      description:
        "Fetch a URL. If the server answers 402 Payment Required (x402), pay it from the agent's allowance and " +
        "fetch again. Returns the response body.",
      inputSchema: z.object({
        url: z.string().describe("http(s) URL"),
        max_amount: z.string().optional().describe("Refuse to pay more than this (token units)"),
      }),
    },
    async ({ url, max_amount }) => result(await backend.fetchPaid({ url, maxAmount: max_amount })),
  );

  server.registerTool(
    "payment_status",
    {
      description: "Check a payment that was waiting for the human co-signer.",
      inputSchema: z.object({ id: z.string().describe("Request id returned by pay or fetch_paid") }),
    },
    async ({ id }) => result(await backend.paymentStatus({ id })),
  );

  return server;
}
