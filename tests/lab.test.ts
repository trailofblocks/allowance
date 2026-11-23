// The red-team lab, with every number the README reports asserted here, so the tables can't drift.
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { USDC } from "../src/local.js";
import { renderReport } from "../src/lab/report.js";
import { runLab, type RunResult, type VariantId } from "../src/lab/runner.js";

let results: RunResult[];
const get = (s: string, v: VariantId) => {
  const r = results.find((x) => x.scenario === s && x.variant === v);
  assert.ok(r, `missing result ${s}/${v}`);
  return r;
};
const u = (whole: number) => BigInt(Math.round(whole * 100)) * (USDC / 100n);

before(async () => {
  results = await runLab({ variants: ["baseline", "allowance", "allowlist-only", "limits-only", "cosigner-only", "no-window-budget"] });
});

describe("attacks, hot wallet vs allowance", () => {
  // [id, baseline loss, baseline attacker gain, allowance loss, co-signer prompts under allowance]
  const expected: Array<[string, number, number, number, number]> = [
    ["R1", 480, 480, 0, 1],
    ["R2", 1450, 0, 0, 0],
    ["R3", 25, 25, 0, 0],
    ["R4", 450, 0, 0, 1],
    ["R5", 499.5, 0, 199.8, 30],
    ["R6", 450, 0, 180, 3],
    ["R7", 300, 300, 0, 0],
    ["R8", 10_000, 10_000, 0, 0],
    ["R9", 0, 0, 0, 0],
    ["R10", 499.5, 0, 399.6, 10],
  ];
  for (const [id, baseLoss, baseGain, loss, prompts] of expected) {
    test(`${id}`, () => {
      const b = get(id, "baseline");
      const a = get(id, "allowance");
      assert.equal(b.loss, u(baseLoss), "baseline loss");
      assert.equal(b.attackerGain, u(baseGain), "baseline attacker gain");
      assert.equal(a.loss, u(loss), "allowance loss");
      assert.equal(a.attackerGain, 0n, "nothing reaches an unlisted address");
      assert.equal(a.prompts, prompts, "co-signer prompts");
      assert.equal(a.approvals, id === "R1" ? 1 : 0, "the co-signer approved only the real invoice");
      assert.ok(a.held, "within the policy's bound");
    });
  }

  test("the compromised agent key changes nothing on-chain (R7, R8)", () => {
    const r7 = get("R7", "allowance").keyLevel;
    assert.match(r7[0]!, /went through/); // its own, empty policy
    assert.ok(r7.slice(1).every((n) => /refused/.test(n)), r7.join("\n"));
    const r8 = get("R8", "allowance").keyLevel;
    assert.equal(r8.length, 6);
    assert.ok(r8.every((n) => /refused/.test(n)), r8.join("\n"));
  });
});

describe("benign workflows", () => {
  for (const id of ["B1", "B2", "B3", "B4", "B5", "B6"]) {
    test(`${id} completes with and without allowance`, () => {
      assert.ok(get(id, "baseline").completed);
      const a = get(id, "allowance");
      assert.ok(a.completed);
      assert.equal(a.prompts, id === "B4" || id === "B6" ? 1 : 0);
      assert.equal(a.approvals, a.prompts);
    });
  }
});

describe("ablation: each layer alone", () => {
  const loss = (s: string, v: VariantId) => get(s, v).loss;
  test("the allowlist alone stops redirection but not inflation or salami", () => {
    for (const s of ["R1", "R3", "R7", "R8"]) assert.equal(loss(s, "allowlist-only"), 0n, s);
    for (const s of ["R2", "R4", "R5", "R6", "R10"]) assert.ok(loss(s, "allowlist-only") > 0n, s);
  });
  test("caps alone don't stop a payment to the attacker", () => {
    assert.equal(loss("R1", "limits-only"), u(480));
    assert.equal(loss("R3", "limits-only"), u(25));
    assert.equal(loss("R7", "limits-only"), u(600));
  });
  test("the co-signer alone stops everything, at 38 prompts for six ordinary tasks", () => {
    for (const s of ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R10"]) assert.equal(loss(s, "cosigner-only"), 0n, s);
    const prompts = ["B1", "B2", "B3", "B4", "B5", "B6"].reduce((n, s) => n + get(s, "cosigner-only").prompts, 0);
    assert.equal(prompts, 38);
    assert.equal(get("R5", "cosigner-only").prompts, 50);
  });
  test("without the window budget, splitting and salami get through", () => {
    assert.equal(loss("R5", "no-window-budget"), u(499.5));
    assert.equal(loss("R6", "no-window-budget"), u(450));
    assert.equal(loss("R10", "no-window-budget"), u(499.5));
  });
});

test("the report renders the headline", () => {
  const md = renderReport(results);
  assert.match(md, /Attacks held with allowance: \*\*10\/10\*\* \(7 with no loss, 3 with a loss inside the policy's bound\)/);
  assert.match(md, /Without allowance, 9\/10 attacks cost money/);
  assert.match(md, /Benign workflows that asked the co-signer: 2\/6; failed: 0\/6/);
});
