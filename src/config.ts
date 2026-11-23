import { getAddress } from "viem";
import type { TokenInfo } from "./mcp/allowance-backend.js";

/** Parse "USDC=0xabc...:6,EURC=0xdef...:6". */
export function parseTokens(spec: string): Record<string, TokenInfo> {
  const out: Record<string, TokenInfo> = {};
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^([A-Za-z0-9]+)=(0x[0-9a-fA-F]{40}):(\d+)$/.exec(part);
    if (!m) throw new Error(`bad token spec "${part}"; expected SYMBOL=0xADDRESS:DECIMALS`);
    out[m[1]!] = { address: getAddress(m[2]!), decimals: Number(m[3]) };
  }
  return out;
}
