// The agent wallet. One EVM key per user. The same address works on every EVM chain and on Hyperliquid.
// The server holds the key, so this is a custodial design: the key is encrypted at rest (AES-256-GCM,
// secret from KMS or KEY_ENCRYPTION_SECRET) and funds can leave only through agent actions or to the owner's sign-in address.
import { createPublicClient, createWalletClient, defineChain, erc20Abi, formatUnits, http, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { config } from "./config";
import { decrypt, encrypt } from "./crypto";
import { sql } from "./db";
import { CHAINS, USDC, type ChainKey } from "./registry/chains";

interface Row { user_id: string; evm_address: string; enc_key: string; auto_execute: boolean; max_action_usd: string }

export interface AgentWallet { userId: string; address: Address; autoExecute: boolean; maxActionUsd: number }

const toWallet = (r: Row): AgentWallet => ({ userId: r.user_id, address: r.evm_address as Address, autoExecute: r.auto_execute, maxActionUsd: Number(r.max_action_usd) });

export async function getOrCreateWallet(userId: string): Promise<AgentWallet> {
  const [existing] = await sql()<Row[]>`select * from agent_wallets where user_id = ${userId}`;
  if (existing) return toWallet(existing);
  const pk = generatePrivateKey();
  const address = privateKeyToAccount(pk).address;
  // "on conflict do nothing": two parallel requests create one wallet.
  await sql()`insert into agent_wallets (user_id, evm_address, enc_key) values (${userId}, ${address}, ${encrypt(pk)}) on conflict (user_id) do nothing`;
  const [row] = await sql()<Row[]>`select * from agent_wallets where user_id = ${userId}`;
  return toWallet(row!);
}

export async function updateWalletSettings(userId: string, s: { autoExecute?: boolean; maxActionUsd?: number }) {
  await sql()`update agent_wallets set auto_execute = coalesce(${s.autoExecute ?? null}, auto_execute), max_action_usd = coalesce(${s.maxActionUsd ?? null}, max_action_usd) where user_id = ${userId}`;
  return getOrCreateWallet(userId);
}

/** The signing account. Only executors call this. The key never leaves the API or guard process. */
export async function walletAccount(userId: string) {
  const [row] = await sql()<Row[]>`select * from agent_wallets where user_id = ${userId}`;
  if (!row) throw new Error("This user has no agent wallet.");
  return privateKeyToAccount(decrypt(row.enc_key) as `0x${string}`);
}

export function viemChain(chain: ChainKey) {
  const c = CHAINS[chain];
  if (c.vm !== "evm" || !c.chainId) throw new Error(`${c.name} is not an EVM chain.`);
  return defineChain({ id: c.chainId, name: c.name, nativeCurrency: { name: "native", symbol: chain === "tempo" ? "USD" : chain === "hyperevm" ? "HYPE" : "ETH", decimals: 18 }, rpcUrls: { default: { http: [c.rpc()] } } });
}

export const publicClient = (chain: ChainKey) => createPublicClient({ chain: viemChain(chain), transport: http() });

export async function signerClient(userId: string, chain: ChainKey) {
  return createWalletClient({ account: await walletAccount(userId), chain: viemChain(chain), transport: http() });
}

const BALANCE_CHAINS: ChainKey[] = ["ethereum", "arbitrum", "base"];

/** Native and USDC balances on the main EVM chains. A failed RPC gives `null` for that chain, not zero. */
export async function walletBalances(address: Address) {
  return Promise.all(
    BALANCE_CHAINS.map(async (chain) => {
      try {
        const client = publicClient(chain);
        const usdc = USDC[chain]!;
        const [native, token] = await Promise.all([
          client.getBalance({ address }),
          client.readContract({ address: usdc.address as Address, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
        ]);
        return { chain, chainName: CHAINS[chain].name, eth: Number(formatUnits(native, 18)), usdc: Number(formatUnits(token, usdc.decimals)), error: null as string | null };
      } catch (err) {
        return { chain, chainName: CHAINS[chain].name, eth: null, usdc: null, error: err instanceof Error ? err.message.slice(0, 120) : "RPC failed" };
      }
    }),
  );
}

export function maxActionUsdDefault() {
  return config().USER_DAILY_LLM_BUDGET_USD * 50;
}
