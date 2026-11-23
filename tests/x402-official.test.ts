// Interop check: the official x402 facilitator (@x402/evm, ExactEvmScheme) verifies and settles payments
// made by an allowance smart account, and refuses authorizations the module didn't reserve.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { createWalletClient, http, publicActions, type Address, type Hex, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { eip3009TokenAbi } from "../src/abi.js";
import { localAddress, localKey, type LocalSetup, setupLocal, USDC } from "../src/local.js";
import { AllowanceSigner, TRANSFER_WITH_AUTHORIZATION_TYPES } from "../src/x402/signers.js";
import type { PaymentPayload, PaymentRequirements } from "../src/x402/types.js";

const merchant = localAddress("api-merchant");
const attacker = localAddress("attacker");
let s: LocalSetup;
let official: ExactEvmScheme;

const requirements = (payTo: Address, amount: bigint): PaymentRequirements => ({
  scheme: "exact",
  network: `eip155:${foundry.id}`,
  amount: amount.toString(),
  asset: s.deployment.token,
  payTo,
  maxTimeoutSeconds: 120,
  extra: { name: "Mock USDC", version: "2" },
});

const balance = (who: Address) =>
  s.chain.public.readContract({ address: s.deployment.token, abi: eip3009TokenAbi, functionName: "balanceOf", args: [who] });

before(async () => {
  s = await setupLocal({ recipients: [merchant] });
  // The official facilitator checks validity windows against the wall clock, so move chain time there.
  await s.chain.test.setNextBlockTimestamp({ timestamp: BigInt(Math.floor(Date.now() / 1000)) });
  await s.chain.test.mine({ blocks: 1 });
  const account = privateKeyToAccount(localKey("official-facilitator"));
  await s.chain.test.setBalance({ address: account.address, value: 10n ** 18n });
  const client = createWalletClient({ account, chain: foundry, transport: http(s.chain.url), pollingInterval: 10 }).extend(publicActions);
  official = new ExactEvmScheme(toFacilitatorEvmSigner({ ...client, address: account.address } as never));
});

after(async () => {
  await s.chain.stop();
});

test("the official facilitator verifies and settles a reserved smart-account payment", async () => {
  const req = requirements(merchant, 3n * USDC);
  const auth = await new AllowanceSigner(s.client()).authorize(req, await s.chain.now());
  assert.equal(auth.status, "ready");
  if (auth.status !== "ready") return;
  const payload: PaymentPayload = { x402Version: 2, accepted: req, payload: auth.payload };

  const verified = await official.verify(payload as never, req as never);
  assert.equal(verified.isValid, true, JSON.stringify(verified));
  assert.equal(verified.payer?.toLowerCase(), s.account.toLowerCase());

  const settled = await official.settle(payload as never, req as never);
  assert.equal(settled.success, true, JSON.stringify(settled));
  assert.equal(await balance(merchant), 3n * USDC);
});

test("the official facilitator refuses an authorization the module never reserved", async () => {
  const req = requirements(attacker, 3n * USDC);
  const now = await s.chain.now();
  const authorization = {
    from: s.account,
    to: attacker,
    value: (3n * USDC).toString(),
    validAfter: (now - 600n).toString(),
    validBefore: (now + 120n).toString(),
    nonce: toHex(new Uint8Array(32).fill(7)),
  };
  // 1. The module's address as the "signature", hoping the account vouches for it anyway.
  const viaModule: PaymentPayload = { x402Version: 2, accepted: req, payload: { signature: s.deployment.module.toLowerCase(), authorization } };
  const r1 = await official.verify(viaModule as never, req as never);
  assert.equal(r1.isValid, false);

  // 2. The agent's own key signs the typed data for the account.
  const agentSig: Hex = await s.agent.signTypedData({
    domain: { name: "Mock USDC", version: "2", chainId: foundry.id, verifyingContract: s.deployment.token },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: s.account,
      to: attacker,
      value: 3n * USDC,
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  });
  const viaAgentKey: PaymentPayload = { x402Version: 2, accepted: req, payload: { signature: agentSig, authorization } };
  const r2 = await official.verify(viaAgentKey as never, req as never);
  assert.equal(r2.isValid, false);
  const r3 = await official.settle(viaAgentKey as never, req as never);
  assert.equal(r3.success, false);
  assert.equal(await balance(attacker), 0n);
});
