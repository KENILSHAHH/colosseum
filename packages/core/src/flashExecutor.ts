// The shared FlashExecutor: one contract for every user, deployed one time on each chain (source: contracts/flash-executor).
// It takes an optional flash loan (Morpho with no fee, or Aave v3), runs steps, and sends what is left to the wallet.
// A step makes a wallet act through a permission whose delegate is the executor. Each such permission names the agent wallet
// of the user as the only address that may start a run (ArgsEqualityCheckEnforcer). So the agent never deploys code for
// a flash loan, an unwind or a leveraged position: it only describes the steps.
import { randomBytes } from "node:crypto";
import { createDelegation, getSmartAccountsEnvironment, ScopeType } from "@metamask/smart-accounts-kit";
import { encodeDelegations, SIGNABLE_DELEGATION_TYPED_DATA } from "@metamask/smart-accounts-kit/utils";
import { concat, createWalletClient, encodeAbiParameters, encodeFunctionData, getContractAddress, http, toFunctionSelector, zeroHash, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { aaveBook } from "./adapters/aave";
import type { EvmTx } from "./adapters/evm";
import artifact from "./flashExecutor.artifact.json";
import { config } from "./config";
import { CHAINS, type ChainKey } from "./registry/chains";
import { getOrCreateWallet, publicClient, viemChain, walletAccount } from "./wallet";

export const EXECUTOR_ABI = artifact.abi as readonly unknown[];
const CREATE2_DEPLOYER = "0x4e59b44847b379578588920cA78FbF26c0B4956C" as const;
/** Chains where the executor runs: the DelegationManager and the enforcer have the same address on each, so the executor does too. */
export const EXECUTOR_CHAINS = ["ethereum", "arbitrum", "base", "robinhood"] as const satisfies readonly ChainKey[];
export type ExecutorChain = (typeof EXECUTOR_CHAINS)[number];
/** Morpho Blue. Source: https://docs.morpho.org/get-started/resources/addresses (read on-chain on 2026-10-12: Ethereum and Base). */
export const MORPHO: Partial<Record<ExecutorChain, Address>> = { ethereum: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb", base: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb" };

const env = (chain: ChainKey) => getSmartAccountsEnvironment(CHAINS[chain].chainId!);
const argsEnforcer = (chain: ChainKey) => env(chain).caveatEnforcers.ArgsEqualityCheckEnforcer as Address;

function initCode(): Hex {
  const e = env("base");
  return concat([artifact.bytecode as Hex, encodeAbiParameters([{ type: "address" }, { type: "address" }], [e.DelegationManager as Address, e.caveatEnforcers.ArgsEqualityCheckEnforcer as Address])]);
}

/** The executor address. The same on every chain of EXECUTOR_CHAINS. */
export const executorAddress = (): Address => getContractAddress({ opcode: "CREATE2", from: CREATE2_DEPLOYER, salt: zeroHash, bytecode: initCode() });

export async function isDeployed(chain: ChainKey) {
  const code = await publicClient(chain).getCode({ address: executorAddress() });
  return !!code && code !== "0x";
}

/** Deploy the executor on a chain with the gas sponsor key. An operator task, done one time on each chain. */
export async function deployExecutor(chain: ExecutorChain): Promise<{ address: Address; hash: Hex | null }> {
  if (await isDeployed(chain)) return { address: executorAddress(), hash: null };
  const key = config().SPONSOR_PRIVATE_KEY;
  if (!key) throw new Error("SPONSOR_PRIVATE_KEY is not set.");
  const wallet = createWalletClient({ account: privateKeyToAccount(key as Hex), chain: viemChain(chain), transport: http() });
  const hash = await wallet.sendTransaction({ to: CREATE2_DEPLOYER, data: concat([zeroHash, initCode()]) });
  const r = await publicClient(chain).waitForTransactionReceipt({ hash, timeout: 180_000 });
  // A public RPC can serve the code read from a node that has not seen the new block yet, so it reads again.
  let ok = r.status === "success" && (await isDeployed(chain));
  for (let i = 0; !ok && r.status === "success" && i < 5; i++) {
    await new Promise((res) => setTimeout(res, 2000));
    ok = await isDeployed(chain);
  }
  if (!ok) throw new Error(`The executor deployment ${hash} failed on ${CHAINS[chain].name}.`);
  return { address: executorAddress(), hash };
}

/** The caveat that lets only `starter` start a run with a permission. */
export const starterCaveat = (chain: ChainKey, starter: Address) => ({ enforcer: argsEnforcer(chain), terms: encodeAbiParameters([{ type: "address" }], [starter]), args: "0x" as Hex });

export interface FlashStep {
  /** "executor": the executor makes the call. "agent": the agent wallet makes it. "linked": the user's own wallet makes it. */
  from: "executor" | "agent" | "linked";
  to: Address;
  value?: string;
  data: Hex;
  description: string;
}

/**
 * A short permission from the agent wallet to the executor for exactly the calls of this run. The server holds the key, so it signs it.
 * It ends after one hour and only the agent wallet can start a run with it.
 */
async function agentPermission(userId: string, chain: ExecutorChain, calls: FlashStep[]): Promise<Hex> {
  const owner = await walletAccount(userId);
  const chainId = CHAINS[chain].chainId!;
  const d = createDelegation({
    from: owner.address, to: executorAddress(), environment: env(chain),
    scope: {
      type: ScopeType.FunctionCall,
      targets: [...new Set(calls.map((c) => c.to.toLowerCase() as Address))],
      selectors: [...new Set(calls.map((c) => c.data.slice(0, 10) as Hex))],
      valueLte: { maxValue: calls.reduce((m, c) => (BigInt(c.value ?? 0) > m ? BigInt(c.value ?? 0) : m), 0n) },
    },
    caveats: [{ type: "timestamp", afterThreshold: 0, beforeThreshold: Math.floor(Date.now() / 1000) + 3600 }],
  } as never) as unknown as { delegate: Address; delegator: Address; authority: Hex; caveats: { enforcer: Address; terms: Hex; args: Hex }[] };
  const caveats = [...d.caveats, starterCaveat(chain, owner.address)];
  const salt = BigInt(`0x${randomBytes(16).toString("hex")}`);
  const signature = await owner.signTypedData({
    domain: { name: "DelegationManager", version: "1", chainId, verifyingContract: env(chain).DelegationManager as Address },
    types: SIGNABLE_DELEGATION_TYPED_DATA, primaryType: "Delegation",
    message: { delegate: d.delegate, delegator: d.delegator, authority: d.authority, caveats: caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms })), salt },
  } as never);
  return encodeDelegations([{ delegate: d.delegate, delegator: d.delegator, authority: d.authority, caveats, salt, signature }] as never) as Hex;
}

/**
 * Build the one transaction that runs a flash-loan plan: the agent wallet calls the executor.
 * `linkedPermission` returns the encoded signed delegation of an active permission of the linked wallet (delegate: the executor).
 */
export async function buildFlashRun(userId: string, args: {
  chain: ExecutorChain;
  lender: "none" | "morpho" | "aave_v3";
  token?: Address;
  amount?: string;
  steps: FlashStep[];
  sweep: Address[];
  linkedPermission?: (step: FlashStep) => Promise<{ wallet: Address; permission: Hex }>;
  /** Who gets what is left at the end. Default: the agent wallet. */
  recipient?: Address;
}): Promise<EvmTx> {
  if (!(await isDeployed(args.chain))) throw new Error(`The shared executor is not deployed on ${CHAINS[args.chain].name} yet.`);
  const agent = (await getOrCreateWallet(userId)).address;
  const agentCalls = args.steps.filter((s) => s.from === "agent");
  const agentCtx = agentCalls.length ? await agentPermission(userId, args.chain, agentCalls) : null;
  const steps = [];
  for (const s of args.steps) {
    if (s.from === "executor") steps.push({ wallet: "0x0000000000000000000000000000000000000000", target: s.to, value: BigInt(s.value ?? 0), data: s.data, permission: "0x" });
    else if (s.from === "agent") steps.push({ wallet: agent, target: s.to, value: BigInt(s.value ?? 0), data: s.data, permission: agentCtx! });
    else {
      if (!args.linkedPermission) throw new Error("A linked-wallet step needs an active permission for the executor.");
      const p = await args.linkedPermission(s);
      steps.push({ wallet: p.wallet, target: s.to, value: BigInt(s.value ?? 0), data: s.data, permission: p.permission });
    }
  }
  let lender = 0, pool: Address = "0x0000000000000000000000000000000000000000";
  if (args.lender === "morpho") {
    const m = MORPHO[args.chain];
    if (!m) throw new Error(`Morpho has no flash loan on ${CHAINS[args.chain].name} here. Use aave_v3.`);
    lender = 1; pool = m;
  } else if (args.lender === "aave_v3") {
    if (args.chain === "robinhood") throw new Error("Aave v3 is not on Robinhood Chain.");
    lender = 2; pool = aaveBook(args.chain).POOL as Address;
  }
  const data = encodeFunctionData({
    abi: EXECUTOR_ABI, functionName: "run",
    args: [lender, pool, args.token ?? "0x0000000000000000000000000000000000000000", BigInt(args.amount ?? 0), steps, args.sweep, args.recipient ?? agent],
  } as never);
  const summary = args.steps.map((s, i) => `${i + 1}. ${s.from}: ${s.description}`).join(" ");
  return { to: executorAddress(), data, value: "0", description: `Flash run${args.lender === "none" ? "" : ` (${args.lender} flash loan)`}: ${summary}`.slice(0, 400) };
}

/** True when an active linked-wallet permission for the executor covers this call. */
export const coversCall = (p: { targets: string[]; functions: string[] }, s: FlashStep) =>
  p.targets.includes(s.to.toLowerCase()) && p.functions.some((f) => toFunctionSelector(f) === s.data.slice(0, 10).toLowerCase());
