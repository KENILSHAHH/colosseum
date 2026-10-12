// The wallet of a user. It is the Privy wallet of the user when the user added the server signer to it: Privy keeps the key
// in parts, and the server signs through the signer that the user can remove. Else it is the legacy key of this server
// (encrypted at rest with AES-256-GCM). The legacy key stays the Hyperliquid account of the user, where its positions are.
import { createPublicClient, createWalletClient, defineChain, erc20Abi, formatUnits, http, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { config } from "./config";
import { decrypt, encrypt } from "./crypto";
import { sql } from "./db";
import { depositAccount, syncDepositWallet } from "./privy";
import { CHAINS, USDC, type ChainKey } from "./registry/chains";

interface Row { user_id: string; evm_address: string; enc_key: string; auto_execute: boolean; max_action_usd: string }

export interface AgentWallet {
  userId: string;
  /** The wallet on every EVM chain and on Tempo: the Privy wallet, or the legacy key when Privy is not set up. */
  address: Address;
  /** The Hyperliquid account: the legacy key. */
  hlAddress: Address;
  privy: boolean;
  autoExecute: boolean;
  maxActionUsd: number;
}

/** The Privy wallet of the user when the server can sign for it. A missing signer is checked at Privy at most every 5 minutes. */
const privyChecked = new Map<string, number>();
async function privyWallet(userId: string): Promise<{ address: Address; walletId: string } | null> {
  const [u] = await sql()<{ deposit_wallet: string | null; privy_wallet_id: string | null; deposit_signer: boolean; privy_did: string | null }[]>`select deposit_wallet, privy_wallet_id, deposit_signer, privy_did from users where id = ${userId}`;
  if (u?.deposit_wallet && u.privy_wallet_id && u.deposit_signer) return { address: u.deposit_wallet as Address, walletId: u.privy_wallet_id };
  if (!u?.privy_did || Date.now() - (privyChecked.get(userId) ?? 0) < 300_000) return null;
  privyChecked.set(userId, Date.now());
  const d = await syncDepositWallet(userId).catch(() => null);
  return d?.enabled && d.address && d.walletId ? { address: d.address as Address, walletId: d.walletId } : null;
}

async function toWallet(r: Row): Promise<AgentWallet> {
  const p = await privyWallet(r.user_id);
  return { userId: r.user_id, address: p?.address ?? (r.evm_address as Address), hlAddress: r.evm_address as Address, privy: !!p, autoExecute: r.auto_execute, maxActionUsd: Number(r.max_action_usd) };
}

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

/** The signing account of the wallet: the Privy wallet through the server signer, or the legacy key. Only executors call this. */
export async function walletAccount(userId: string) {
  const p = await privyWallet(userId);
  if (p) return depositAccount(p) as ReturnType<typeof privateKeyToAccount>;
  return legacyAccount(userId);
}

/** The legacy key. It signs for the Hyperliquid account. The key never leaves the API or guard process. */
export async function legacyAccount(userId: string) {
  await getOrCreateWallet(userId);
  const [row] = await sql()<Row[]>`select * from agent_wallets where user_id = ${userId}`;
  return privateKeyToAccount(decrypt(row!.enc_key) as `0x${string}`);
}

export function viemChain(chain: ChainKey) {
  const c = CHAINS[chain];
  if (c.vm !== "evm" || !c.chainId) throw new Error(`${c.name} is not an EVM chain.`);
  return defineChain({ id: c.chainId, name: c.name, nativeCurrency: { name: "native", symbol: chain === "tempo" ? "USD" : chain === "hyperevm" ? "HYPE" : chain === "polygon" ? "POL" : "ETH", decimals: 18 }, rpcUrls: { default: { http: [c.rpc()] } } });
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
