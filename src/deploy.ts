import { type Address, encodeFunctionData, encodePacked, type Hex, zeroHash } from "viem";
import { agentAccountAbi, allowanceModuleAbi, eip3009TokenAbi } from "./abi.js";
import { bytecode } from "./artifacts.js";
import type { LocalChain, Wallet } from "./chain.js";
import { encodeInitConfig, type InitConfig } from "./policy.js";

export const MODULE_TYPE_VALIDATOR = 1n;
export const MODULE_TYPE_EXECUTOR = 2n;

/** ERC-7579 execution mode 0: one call, revert on failure. */
export const SINGLE_CALL_MODE: Hex = zeroHash;

async function deploy(chain: LocalChain, wallet: Wallet, file: string, contract: string, abi: readonly unknown[], args: unknown[] = []) {
  const hash = await wallet.deployContract({
    abi: abi as never,
    bytecode: bytecode(file, contract),
    args: args as never,
  });
  const receipt = await chain.public.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error(`deploying ${contract} failed`);
  return receipt.contractAddress;
}

export interface Deployment {
  module: Address;
  token: Address;
  accountImpl: Address;
}

/** Deploy the module, a mock EIP-3009 stablecoin, and the AgentAccount implementation. */
export async function deployContracts(chain: LocalChain, deployer: Wallet): Promise<Deployment> {
  const module = await deploy(chain, deployer, "AllowanceModule.sol", "AllowanceModule", allowanceModuleAbi);
  const token = await deploy(chain, deployer, "MockEIP3009Token.sol", "MockEIP3009Token", eip3009TokenAbi, [
    "Mock USDC",
    "mUSDC",
  ]);
  const accountImpl = await deploy(chain, deployer, "AgentAccount.sol", "AgentAccount", agentAccountAbi);
  return { module, token, accountImpl };
}

/** Encode `execute(mode 0, target ++ value ++ data)` on an ERC-7579 account. */
export function encodeExecute(target: Address, data: Hex, value = 0n): Hex {
  return encodeFunctionData({
    abi: agentAccountAbi,
    functionName: "execute",
    args: [SINGLE_CALL_MODE, encodePacked(["address", "uint256", "bytes"], [target, value, data])],
  });
}

/**
 * Upgrade the owner's EOA in place with EIP-7702 and install the module in one go.
 * The owner signs a 7702 authorization for AgentAccount and sends one transaction to itself that
 * carries it; later calls (the installs) are ordinary self-calls.
 */
export async function upgradeAndInstall(
  chain: LocalChain,
  owner: Wallet,
  d: Deployment,
  config: InitConfig,
): Promise<Address> {
  const account = owner.account.address;
  const authorization = await owner.signAuthorization({ contractAddress: d.accountImpl, executor: "self" });
  const installExecutor = encodeFunctionData({
    abi: agentAccountAbi,
    functionName: "installModule",
    args: [MODULE_TYPE_EXECUTOR, d.module, encodeInitConfig(config)],
  });
  const h1 = await owner.sendTransaction({ to: account, data: installExecutor, authorizationList: [authorization] });
  await expectSuccess(chain, h1, "installing the module as an executor");
  const installValidator = encodeFunctionData({
    abi: agentAccountAbi,
    functionName: "installModule",
    args: [MODULE_TYPE_VALIDATOR, d.module, "0x"],
  });
  const h2 = await owner.sendTransaction({ to: account, data: installValidator });
  await expectSuccess(chain, h2, "installing the module as a validator");
  return account;
}

/** The owner changes its own policy: a self-call that executes `data` on the module. */
export async function ownerCallsModule(chain: LocalChain, owner: Wallet, module: Address, data: Hex): Promise<Hex> {
  const hash = await owner.sendTransaction({ to: owner.account.address, data: encodeExecute(module, data) });
  await expectSuccess(chain, hash, "owner call to the module");
  return hash;
}

export async function expectSuccess(chain: LocalChain, hash: Hex, what: string): Promise<void> {
  const receipt = await chain.public.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${what} reverted (tx ${hash})`);
}

export async function mint(chain: LocalChain, wallet: Wallet, token: Address, to: Address, amount: bigint): Promise<void> {
  const hash = await wallet.writeContract({ address: token, abi: eip3009TokenAbi, functionName: "mint", args: [to, amount] });
  await expectSuccess(chain, hash, "mint");
}
