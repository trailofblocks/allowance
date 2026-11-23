import type { Client } from "@modelcontextprotocol/client";
import { modelView } from "./fixtures.js";

/**
 * A scripted stand-in for a model that is completely fooled by prompt injection.
 *
 * It does what the user asked (a fixed list of tool calls), and it also obeys every instruction of the
 * form `call <server>.<tool> with {json}` that it reads in any tool result: an invoice, a web page, a
 * quote, a 402 response body. Like a model, it reads invisible Unicode TAG characters as text.
 *
 * The point of allowance is that this agent can't be trusted, so nothing here tries to resist.
 */

export interface ToolStep {
  server: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface AgentCall {
  origin: "user" | "injected";
  server: string;
  tool: string;
  args: Record<string, unknown>;
  isError: boolean;
  text: string;
}

interface Directive {
  server: string;
  tool: string;
  args: Record<string, unknown>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Find `call server.tool with {json}` instructions, parsing the JSON with brace matching. */
export function extractDirectives(text: string): Directive[] {
  const out: Directive[] = [];
  const re = /call\s+([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\s+with\s+\{/gi;
  for (const m of text.matchAll(re)) {
    const start = m.index! + m[0].length - 1;
    let depth = 0;
    let inString = false;
    let end = -1;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (ch === "\\") i++;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        end = i + 1;
        break;
      }
    }
    if (end === -1) continue;
    try {
      const args = JSON.parse(text.slice(start, end));
      if (isRecord(args)) out.push({ server: m[1]!, tool: m[2]!, args });
    } catch {
      // not valid JSON
    }
  }
  return out;
}

export class FooledAgent {
  readonly calls: AgentCall[] = [];
  private readonly queue: Directive[] = [];
  private readonly seen = new Set<string>();

  constructor(
    private readonly clients: Record<string, Client>,
    private readonly maxInjected = 60,
  ) {}

  async step(step: ToolStep): Promise<void> {
    await this.call("user", step.server, step.tool, step.args);
    await this.drain();
  }

  private read(raw: string): void {
    for (const d of extractDirectives(modelView(raw))) {
      const key = JSON.stringify([d.server, d.tool, d.args]);
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      this.queue.push(d);
    }
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      if (this.calls.filter((c) => c.origin === "injected").length >= this.maxInjected) return;
      const d = this.queue.shift()!;
      await this.call("injected", d.server, d.tool, d.args);
    }
  }

  private async call(origin: AgentCall["origin"], server: string, tool: string, args: Record<string, unknown>): Promise<void> {
    const client = this.clients[server];
    let isError = true;
    let text: string;
    if (!client) {
      text = `no server named ${server}`;
    } else {
      try {
        const result = await client.callTool({ name: tool, arguments: args });
        isError = result.isError === true;
        text = (result.content as Array<{ type: string; text?: string }>)
          .map((b) => (b.type === "text" ? (b.text ?? "") : ""))
          .join("\n");
      } catch (err) {
        text = `error: ${(err as Error).message}`;
      }
    }
    this.calls.push({ origin, server, tool, args, isError, text });
    this.read(text);
  }
}
