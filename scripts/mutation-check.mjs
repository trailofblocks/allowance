#!/usr/bin/env node
// Tests for the tests: plant one bug at a time in AllowanceModule.sol and check that the invariant
// suite alone notices. A mutant that survives means an invariant is too weak or the handler never
// reaches the code. The source file is always restored, even on Ctrl-C.
//
//   node scripts/mutation-check.mjs            (uses `forge` on PATH, or $FORGE_BIN)

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.join(root, "contracts", "AllowanceModule.sol");
const forge = process.env.FORGE_BIN || "forge";

const MUTANTS = [
  {
    name: "recipient allowlist not checked",
    from: "if (!s.recipients[to]) revert RecipientNotAllowed(to);",
    to: "",
  },
  {
    name: "co-signature ignores the window total (splitting works)",
    from: "return amt > p.cosignAbove || p.spent + amt > p.autoPerPeriod;",
    to: "return amt > p.cosignAbove;",
  },
  {
    name: "hard cap doubled",
    from: "uint128 left = p.maxPerPeriod > p.spent ? p.maxPerPeriod - p.spent : 0;",
    to: "uint128 left = 2 * p.maxPerPeriod > p.spent ? 2 * p.maxPerPeriod - p.spent : 0;",
  },
  {
    name: "pause does not revoke signatures",
    from: "if (r.amount == 0 || s.paused || block.timestamp >= r.validBefore)",
    to: "if (r.amount == 0 || block.timestamp >= r.validBefore)",
  },
  {
    name: "expired reservations still validate",
    from: "|| block.timestamp >= r.validBefore) return ERC1271_INVALID;",
    to: ") return ERC1271_INVALID;",
  },
  {
    name: "release refunds into any window",
    from: "if (p.anchor == r.anchor && p.windowIndex == r.windowIndex) {",
    to: "if (true) {",
  },
  {
    name: "release refunds authorizations that were used",
    from: "bool used = IEIP3009(r.token).authorizationState(account, r.nonce);",
    to: "bool used = false;",
  },
  {
    name: "per-transaction cap not checked",
    from: "if (amount > p.maxPerTx) revert OverPerTxLimit(amount, p.maxPerTx);",
    to: "",
  },
];

const original = readFileSync(file, "utf8");
const restore = () => writeFileSync(file, original);
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    restore();
    process.exit(130);
  });
}

let survived = 0;
try {
  for (const m of MUTANTS) {
    const count = original.split(m.from).length - 1;
    if (count !== 1) throw new Error(`mutant "${m.name}": pattern found ${count} times, expected 1`);
    writeFileSync(file, original.replace(m.from, m.to));
    const res = spawnSync(forge, ["test", "--match-contract", "AllowanceInvariantTest"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, FOUNDRY_LINT_ON_BUILD: "false" },
    });
    if (res.error) throw res.error;
    const out = `${res.stdout}\n${res.stderr}`;
    if (/Compiler run failed|Error \(\d+\)/.test(out)) throw new Error(`mutant "${m.name}" does not compile:\n${out}`);
    const failed = [...new Set([...out.matchAll(/\[FAIL[^\]]*\]\s+(invariant_\w+)/g)].map((x) => x[1]))];
    const killed = res.status !== 0 && failed.length > 0;
    if (!killed) survived++;
    console.log(`${killed ? "killed  " : "SURVIVED"}  ${m.name}${killed ? `  (${failed.join(", ")})` : ""}`);
  }
} finally {
  restore();
}
console.log(`\n${MUTANTS.length - survived}/${MUTANTS.length} mutants killed by the invariant suite.`);
process.exit(survived === 0 ? 0 : 1);
