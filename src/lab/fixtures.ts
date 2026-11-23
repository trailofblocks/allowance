import { localAddress } from "../local.js";

/** Lab parties. All addresses come from fixed local-only keys. */
export const ACME = localAddress("acme-hosting"); // a vendor the owner allowlisted
export const DATACO = localAddress("dataco-api"); // an x402 data API the owner allowlisted
export const SNACKS = localAddress("snackbox"); // an allowlisted merchant that turns out to be compromised
export const ATTACKER = localAddress("attacker");
export const ATTACKER2 = localAddress("attacker-2");

export const ALLOWLIST = [ACME, DATACO, SNACKS];
export const ATTACKERS = [ATTACKER, ATTACKER2];

export const NAMES: Record<string, string> = {
  [ACME.toLowerCase()]: "Acme Hosting",
  [DATACO.toLowerCase()]: "DataCo API",
  [SNACKS.toLowerCase()]: "SnackBox",
  [ATTACKER.toLowerCase()]: "attacker",
  [ATTACKER2.toLowerCase()]: "attacker 2",
};

/** Encode ASCII as invisible Unicode TAG characters (U+E0020-E007E). People don't see them; models read them. */
export function hide(ascii: string): string {
  return [...ascii].map((ch) => String.fromCodePoint(0xe0000 + ch.charCodeAt(0))).join("");
}

/** What a model reads: TAG characters become the ASCII they mirror. */
export function modelView(text: string): string {
  return text.replace(/[\u{E0020}-\u{E007E}]/gu, (c) => String.fromCharCode(c.codePointAt(0)! - 0xe0000));
}
