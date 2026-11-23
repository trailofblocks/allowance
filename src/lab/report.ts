import { formatUnits } from "viem";
import type { RunResult, VariantId } from "./runner.js";
import { VARIANTS } from "./runner.js";
import { SCENARIOS } from "./scenarios.js";

const usd = (v: bigint) => `${formatUnits(v, 6)}`;
const get = (rs: RunResult[], s: string, v: VariantId) => rs.find((r) => r.scenario === s && r.variant === v);

function asked(r: RunResult): string {
  if (r.prompts === 0) return "0";
  return `${r.prompts} (${r.approvals} approved)`;
}

function baselineCell(r?: RunResult): string {
  if (!r) return "-";
  if (r.loss === 0n) return "no loss";
  return `lost ${usd(r.loss)}${r.attackerGain > 0n ? `, ${usd(r.attackerGain)} to the attacker` : ""}`;
}

function protectedCell(r: RunResult | undefined, bound: bigint): string {
  if (!r) return "-";
  if (!r.held) return `**NOT HELD**: lost ${usd(r.loss)}${r.attackerGain > 0n ? `, ${usd(r.attackerGain)} to the attacker` : ""}`;
  if (r.loss === 0n) return "stopped, no loss";
  return `bounded: lost ${usd(r.loss)} (policy bound ${usd(bound)})`;
}

function benignCell(r?: RunResult): string {
  if (!r) return "-";
  if (!r.completed) return "**fails**";
  return r.approvals > 0 ? `completes after ${r.approvals} co-signer approval${r.approvals > 1 ? "s" : ""}` : "completes, no prompts";
}

const ABLATION: VariantId[] = ["allowlist-only", "limits-only", "cosigner-only", "no-window-budget", "allowance"];

/** Markdown tables for the README and the CLI. Amounts are in USDC. */
export function renderReport(results: RunResult[]): string {
  const out: string[] = [];
  const attacks = SCENARIOS.filter((s) => s.kind === "attack" && results.some((r) => r.scenario === s.id));
  const benign = SCENARIOS.filter((s) => s.kind === "benign" && results.some((r) => r.scenario === s.id));

  if (attacks.length) {
    out.push("| | Attack | Hot wallet (no allowance) | With allowance | Co-signer asked |");
    out.push("| --- | --- | --- | --- | --- |");
    for (const s of attacks) {
      const b = get(results, s.id, "baseline");
      const a = get(results, s.id, "allowance");
      out.push(`| **${s.id}** | ${s.title}${s.note ? ` (${s.note})` : ""} | ${baselineCell(b)} | ${protectedCell(a, s.bound)} | ${a ? asked(a) : "-"} |`);
    }
    out.push("");
  }
  if (benign.length) {
    out.push("| | Benign workflow | Hot wallet (no allowance) | With allowance |");
    out.push("| --- | --- | --- | --- |");
    for (const s of benign) {
      out.push(`| **${s.id}** | ${s.title} | ${benignCell(get(results, s.id, "baseline"))} | ${benignCell(get(results, s.id, "allowance"))} |`);
    }
    out.push("");
  }

  const hasAblation = results.some((r) => r.variant === "allowlist-only");
  if (hasAblation) {
    out.push(`| Loss (co-signer prompts) | ${ABLATION.map((v) => VARIANTS[v].label).join(" | ")} |`);
    out.push(`| --- | ${ABLATION.map(() => "---").join(" | ")} |`);
    for (const s of attacks) {
      if (s.id === "R9") continue;
      const cells = ABLATION.map((v) => {
        const r = get(results, s.id, v);
        if (!r) return "-";
        const p = r.prompts > 0 ? ` (${r.prompts})` : "";
        return r.held ? `${usd(r.loss)}${p}` : `**${usd(r.loss)}**${p}`;
      });
      out.push(`| **${s.id}** ${s.title} | ${cells.join(" | ")} |`);
    }
    const promptTotals = ABLATION.map((v) => results.filter((r) => r.variant === v && r.scenario.startsWith("B")).reduce((n, r) => n + r.prompts, 0));
    out.push(`| Co-signer prompts across B1-B6 | ${promptTotals.join(" | ")} |`);
    out.push("");
  }

  const a = attacks.map((s) => get(results, s.id, "allowance")).filter((r): r is RunResult => !!r);
  const b = attacks.map((s) => get(results, s.id, "baseline")).filter((r): r is RunResult => !!r);
  if (a.length) {
    const zero = a.filter((r) => r.held && r.loss === 0n).length;
    const bounded = a.filter((r) => r.held && r.loss > 0n).length;
    const lostBase = b.filter((r) => r.loss > 0n).length;
    const fp = benign.map((s) => get(results, s.id, "allowance")).filter((r) => r && (r.prompts > 0 || !r.completed)).length;
    const failed = benign.map((s) => get(results, s.id, "allowance")).filter((r) => r && !r.completed).length;
    out.push(
      `Attacks held with allowance: **${a.filter((r) => r.held).length}/${a.length}** (${zero} with no loss, ${bounded} with a loss inside the policy's bound). ` +
        `Without allowance, ${lostBase}/${b.length} attacks cost money. ` +
        `Benign workflows that asked the co-signer: ${fp}/${benign.length}; failed: ${failed}/${benign.length}.`,
    );
  }
  return out.join("\n");
}
