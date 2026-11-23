import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Hex } from "viem";

/** The package root: the nearest directory above this file with foundry.toml. */
export function packageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(path.join(dir, "foundry.toml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("could not find the allowance package root (foundry.toml)");
    dir = parent;
  }
}

/** Creation bytecode from `forge build` output. Deploying contracts needs `forge build` first. */
export function bytecode(file: string, contract: string): Hex {
  const p = path.join(packageRoot(), "out", file, `${contract}.json`);
  if (!existsSync(p)) throw new Error(`missing ${p}; run \`forge build\` first`);
  const artifact = JSON.parse(readFileSync(p, "utf8")) as { bytecode: { object: Hex } };
  return artifact.bytecode.object;
}
