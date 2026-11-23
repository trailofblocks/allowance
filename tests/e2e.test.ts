import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { type Address, type Hex, hashMessage, parseEther } from "viem";
import { agentAccountAbi, allowanceModuleAbi, eip3009TokenAbi } from "../src/abi.js";
import { PolicyError } from "../src/client.js";
import { expectSuccess, mint, ownerCallsModule } from "../src/deploy.js";
import { localAddress, localKey, type LocalSetup, setupLocal, USDC } from "../src/local.js";
import { LocalFacilitator } from "../src/x402/facilitator.js";
import { PaidServer } from "../src/x402/server.js";
import { AllowanceSigner, EoaSigner } from "../src/x402/signers.js";
import { x402Fetch } from "../src/x402/client.js";
import { encodeFunctionData } from "viem";

const vendor = localAddress("vendor");
const merchant = localAddress("api-merchant");
const attacker = localAddress("attacker");

let s: LocalSetup;
let snap: Hex;
let facilitator: LocalFacilitator;
let server: PaidServer;

const balance = (who: Address) =>
  s.chain.public.readContract({ address: s.deployment.token, abi: eip3009TokenAbi, functionName: "balanceOf", args: [who] });

before(async () => {
  s = await setupLocal({ recipients: [vendor, merchant] });
  facilitator = new LocalFacilitator(s.chain.public, s.facilitator);
  const price = (payTo: Address, amount: bigint) => ({ amount, asset: s.deployment.token, payTo, name: "Mock USDC", version: "2" });
  server = new PaidServer({
    facilitator,
    routes: {
      "/free": { body: "free page" },
      "/data": { body: "the paid data", price: price(merchant, 2n * USDC) },
      "/pricey": { body: "pricey data", price: price(merchant, 150n * USDC) },
      "/evil": { body: "you paid the attacker", price: price(attacker, 2n * USDC) },
    },
  });
  await server.start();
  snap = await s.chain.snapshot();
});

beforeEach(async () => {
  await s.chain.revert(snap);
  snap = await s.chain.snapshot();
});

after(async () => {
  await server.stop();
  await s.chain.stop();
});

describe("on-chain setup", () => {
  test("the owner's EOA is upgraded in place and carries the policy", async () => {
    const code = await s.chain.public.getCode({ address: s.account });
    assert.ok(code?.startsWith("0xef0100"), "EIP-7702 delegation designator");
    assert.equal(s.account, s.owner.account.address);
    const st = await s.client().status(s.deployment.token);
    assert.equal(st.maxPerTx, 500n * USDC);
    assert.equal(st.autoLeft, 200n * USDC);
    assert.equal(st.hardLeft, 1_000n * USDC);
    assert.equal(st.cosigner, s.cosigner.account.address);
    assert.equal(st.paused, false);
  });

  test("the owner's own key still signs ERC-1271 messages", async () => {
    const hash = hashMessage("hello");
    const sig = await s.owner.signMessage({ message: "hello" });
    const magic = await s.chain.public.readContract({ address: s.account, abi: agentAccountAbi, functionName: "isValidSignature", args: [hash, sig] });
    assert.equal(magic, "0x1626ba7e");
  });
});

describe("pay", () => {
  test("a payment inside the auto budget goes straight through", async () => {
    const res = await s.client().pay(s.deployment.token, vendor, 40n * USDC);
    assert.equal(res.status, "paid");
    assert.equal(await balance(vendor), 40n * USDC);
  });

  test("a refusal comes back as a readable PolicyError and costs nothing", async () => {
    const before = await s.chain.public.getTransactionCount({ address: s.agent.account.address });
    await assert.rejects(s.client().pay(s.deployment.token, attacker, 10n * USDC), (err: unknown) => {
      assert.ok(err instanceof PolicyError);
      assert.equal(err.code, "RecipientNotAllowed");
      assert.match(err.message, /not on the account's allowlist/);
      return true;
    });
    await assert.rejects(s.client().pay(s.deployment.token, vendor, 600n * USDC), (err: unknown) => {
      assert.ok(err instanceof PolicyError);
      assert.equal(err.code, "OverPerTxLimit");
      assert.match(err.message, /600 USDC is above the per-payment limit of 500 USDC/);
      return true;
    });
    assert.equal(await s.chain.public.getTransactionCount({ address: s.agent.account.address }), before);
    assert.equal(await balance(attacker), 0n);
  });

  test("a large payment waits for the co-signer, then runs on approval", async () => {
    const client = s.client();
    const res = await client.pay(s.deployment.token, vendor, 150n * USDC);
    assert.equal(res.status, "pending");
    assert.equal(await balance(vendor), 0n);
    const id = res.status === "pending" ? res.pendingId : 0n;
    assert.equal(await client.requestState(id), "pending");
    const h = await s.cosigner.writeContract({ address: s.deployment.module, abi: allowanceModuleAbi, functionName: "approve", args: [s.account, id] });
    await expectSuccess(s.chain, h, "approve");
    assert.equal(await client.requestState(id), "approved");
    assert.equal(await balance(vendor), 150n * USDC);
  });

  test("the client can wait for the co-signer's answer", async () => {
    const client = s.client({ approvalWaitMs: 5_000, pollMs: 20 });
    // The co-signer rejects whatever shows up next.
    const watcher = (async () => {
      for (let i = 0; i < 200; i++) {
        const [, , , , next] = await s.chain.public.readContract({ address: s.deployment.module, abi: allowanceModuleAbi, functionName: "settings", args: [s.account] });
        if (next > 0n) {
          await s.cosigner.writeContract({ address: s.deployment.module, abi: allowanceModuleAbi, functionName: "reject", args: [s.account, next] });
          return;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
    })();
    const res = await client.pay(s.deployment.token, vendor, 150n * USDC);
    await watcher;
    assert.equal(res.status, "rejected");
    assert.equal(await balance(vendor), 0n);
  });

  test("the owner can tighten the policy at any time", async () => {
    const data = encodeFunctionData({ abi: allowanceModuleAbi, functionName: "setRecipient", args: [vendor, false] });
    await ownerCallsModule(s.chain, s.owner, s.deployment.module, data);
    await assert.rejects(s.client().pay(s.deployment.token, vendor, 1n * USDC), /allowlist/);
  });
});

describe("x402", () => {
  const network = () => `eip155:${s.chain.public.chain.id}`;

  test("a free page needs no payment", async () => {
    const out = await x402Fetch(server.url("/free"), { signer: new AllowanceSigner(s.client()), network: network(), now: () => s.chain.now() });
    assert.equal(out.status, "free");
  });

  test("the smart account pays a 402 through a reservation and ERC-1271", async () => {
    const out = await x402Fetch(server.url("/data"), { signer: new AllowanceSigner(s.client()), network: network(), now: () => s.chain.now() });
    assert.equal(out.status, "paid");
    if (out.status !== "paid") return;
    assert.equal(await out.response.text(), "the paid data");
    assert.equal(out.settlement?.success, true);
    // The signature is the module's 20-byte address: the reservation is the authorization.
    assert.equal(out.payload.payload.signature, s.deployment.module.toLowerCase());
    assert.equal(out.payload.payload.authorization.from, s.account);
    assert.equal(await balance(merchant), 2n * USDC);
    const st = await s.client().status(s.deployment.token);
    assert.equal(st.autoLeft, 198n * USDC);
  });

  test("a 402 that names an unlisted payTo is refused before anything is signed", async () => {
    const out = await x402Fetch(server.url("/evil"), { signer: new AllowanceSigner(s.client()), network: network(), now: () => s.chain.now() });
    assert.equal(out.status, "refused");
    if (out.status === "refused") assert.equal(out.code, "RecipientNotAllowed");
    assert.equal(await balance(attacker), 0n);
  });

  test("an expensive 402 waits for the co-signer instead of paying", async () => {
    const out = await x402Fetch(server.url("/pricey"), { signer: new AllowanceSigner(s.client()), network: network(), now: () => s.chain.now() });
    assert.equal(out.status, "pending");
    assert.equal(await balance(merchant), 0n);
  });

  test("a captured payment header can't be replayed", async () => {
    let captured = "";
    const tap = new PaidServer({
      facilitator,
      onPaymentHeader: (h) => (captured = h),
      routes: { "/data": { body: "x", price: { amount: 2n * USDC, asset: s.deployment.token, payTo: merchant, name: "Mock USDC", version: "2" } } },
    });
    await tap.start();
    try {
      const out = await x402Fetch(tap.url("/data"), { signer: new AllowanceSigner(s.client()), network: network(), now: () => s.chain.now() });
      assert.equal(out.status, "paid");
      const replay = await fetch(tap.url("/data"), { headers: { "PAYMENT-SIGNATURE": captured } });
      assert.equal(replay.status, 402);
      assert.equal(await balance(merchant), 2n * USDC);
    } finally {
      await tap.stop();
    }
  });

  test("a plain EOA pays with its own signature (the baseline path)", async () => {
    const hot = s.chain.wallet(localKey("hot-wallet"));
    await s.chain.test.setBalance({ address: hot.account.address, value: parseEther("1") });
    await mint(s.chain, s.deployer, s.deployment.token, hot.account.address, 10n * USDC);
    const out = await x402Fetch(server.url("/evil"), { signer: new EoaSigner(hot, s.chain.public.chain.id), network: network(), now: () => s.chain.now() });
    assert.equal(out.status, "paid");
    assert.equal(await balance(attacker), 2n * USDC);
  });
});
