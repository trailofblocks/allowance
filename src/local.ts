import { type Address, type Hex, keccak256, parseEther, toHex } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { LocalChain, type Wallet } from "./chain.js";
import { AllowanceClient } from "./client.js";
import { deployContracts, type Deployment, mint, upgradeAndInstall } from "./deploy.js";
import type { InitConfig, TokenLimits } from "./policy.js";

/** Deterministic keys for local chains only. Never fund these anywhere real. */
export function localKey(label: string): Hex {
  return keccak256(toHex(`allowance local key: ${label}`));
}

export function localAddress(label: string): Address {
  return privateKeyToAddress(localKey(label));
}

export const USDC = 1_000_000n;

/** The limits the lab and the examples use: 500 per payment, co-sign above 100, 200 a day alone, 1,000 a day hard. */
export const DEFAULT_LIMITS: TokenLimits = {
  maxPerTx: 500n * USDC,
  cosignAbove: 100n * USDC,
  autoPerPeriod: 200n * USDC,
  maxPerPeriod: 1_000n * USDC,
  period: 86_400n,
};

export interface LocalSetupOptions {
  recipients: Address[];
  limits?: TokenLimits;
  /** Tokens minted to the account. */
  funding?: bigint;
  pendingTtl?: number;
  maxAuthWindow?: number;
  chain?: LocalChain;
}

export interface LocalSetup {
  chain: LocalChain;
  deployment: Deployment;
  /** The smart account: the owner's EOA, upgraded with EIP-7702. */
  account: Address;
  owner: Wallet;
  agent: Wallet;
  cosigner: Wallet;
  facilitator: Wallet;
  deployer: Wallet;
  config: InitConfig;
  client(opts?: { approvalWaitMs?: number; pollMs?: number }): AllowanceClient;
}

/** Start Anvil (unless given one), deploy everything, upgrade the owner's EOA, and install the module. */
export async function setupLocal(o: LocalSetupOptions): Promise<LocalSetup> {
  const chain = o.chain ?? (await LocalChain.start());
  const deployer = chain.wallet(localKey("deployer"));
  const owner = chain.wallet(localKey("owner"));
  const agent = chain.wallet(localKey("agent"));
  const cosigner = chain.wallet(localKey("cosigner"));
  const facilitator = chain.wallet(localKey("facilitator"));
  for (const w of [deployer, owner, agent, cosigner, facilitator]) {
    await chain.test.setBalance({ address: w.account.address, value: parseEther("10") });
  }
  const deployment = await deployContracts(chain, deployer);
  const config: InitConfig = {
    agents: [agent.account.address],
    cosigner: cosigner.account.address,
    recipients: o.recipients,
    tokens: [{ token: deployment.token, limits: o.limits ?? DEFAULT_LIMITS }],
    pendingTtl: o.pendingTtl ?? 86_400,
    maxAuthWindow: o.maxAuthWindow ?? 3_600,
  };
  const account = await upgradeAndInstall(chain, owner, deployment, config);
  await mint(chain, deployer, deployment.token, account, o.funding ?? 10_000n * USDC);
  return {
    chain,
    deployment,
    account,
    owner,
    agent,
    cosigner,
    facilitator,
    deployer,
    config,
    client: (opts) =>
      new AllowanceClient({
        publicClient: chain.public,
        agent,
        module: deployment.module,
        account,
        approvalWaitMs: opts?.approvalWaitMs,
        pollMs: opts?.pollMs ?? 20,
        units: (t) => (t.toLowerCase() === deployment.token.toLowerCase() ? { decimals: 6, symbol: "USDC" } : undefined),
      }),
  };
}
