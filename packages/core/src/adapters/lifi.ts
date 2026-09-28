// LI.FI, the routing API behind jumper.xyz. Docs: https://docs.li.fi/api-reference/introduction
// It moves any token on any supported EVM chain to OUSD on Tempo. The agent wallet signs the transactions.
import { createPublicClient, createWalletClient, defineChain, erc20Abi, formatUnits, http, type Address, type Hex } from "viem";
import { walletAccount } from "../wallet";
import { getJson } from "./http";

const LIFI = "https://li.quest/v1";
const INTEGRATOR = "payi";
const NATIVE = "0x0000000000000000000000000000000000000000";
export const TEMPO_ID = 4217;
/** OUSD (OpenUSD) on Tempo, 6 decimals. LI.FI lists it at `GET /v1/tokens?chains=4217`. */
export const OUSD_TEMPO = "0x20c0000000000000000000006a37DA5C996874BE";
/** Assets below this value are not shown. A route for them costs more than it moves. */
const MIN_ASSET_USD = 0.25;
/** Part of a native balance that stays in the wallet for gas. */
const NATIVE_KEEP = 0.1;

interface LifiChain { id: number; name: string; coin: string; metamask: { rpcUrls: string[]; blockExplorerUrls: string[]; nativeCurrency: { name: string; symbol: string; decimals: number } } }
interface LifiBalance { address: string; symbol: string; decimals: number; amount: string; chainId: number; verificationStatus?: string }
interface LifiQuote {
  tool: string;
  estimate: { toAmount: string; toAmountMin: string; approvalAddress?: string; executionDuration?: number; gasCosts?: { amount: string; amountUSD?: string }[]; feeCosts?: { amountUSD?: string }[] };
  transactionRequest: { to: Address; data: Hex; value?: string; gasLimit?: string; gasPrice?: string; chainId: number };
}

export interface WalletAsset { chainId: number; chainName: string; symbol: string; token: string; decimals: number; amount: number; usd: number | null; native: boolean }

let chainCache: { at: number; chains: Map<number, LifiChain> } | undefined;
async function chains(): Promise<Map<number, LifiChain>> {
  if (!chainCache || Date.now() - chainCache.at > 3_600_000) {
    const res = await getJson<{ chains: LifiChain[] }>(`${LIFI}/chains?chainTypes=EVM`);
    chainCache = { at: Date.now(), chains: new Map(res.chains.map((c) => [c.id, c])) };
  }
  return chainCache.chains;
}

async function viemChain(chainId: number) {
  const c = (await chains()).get(chainId);
  if (!c) throw new Error(`LI.FI does not support chain ${chainId}.`);
  return defineChain({ id: c.id, name: c.name, nativeCurrency: c.metamask.nativeCurrency, rpcUrls: { default: { http: c.metamask.rpcUrls } }, blockExplorers: { default: { name: "Explorer", url: c.metamask.blockExplorerUrls[0]?.replace(/\/$/, "") ?? "" } } });
}

/** Every token of the address that LI.FI can route, with a USD value. Tempo is not a source: the destination is there. */
export async function walletAssets(address: string): Promise<WalletAsset[]> {
  const [res, known] = await Promise.all([getJson<{ balances: Record<string, LifiBalance[]> }>(`${LIFI}/wallets/${address}/balances`), chains()]);
  const held = Object.values(res.balances).flat().filter((b) => BigInt(b.amount) > 0n && Number(b.chainId) !== TEMPO_ID && b.verificationStatus !== "unverified" && known.has(Number(b.chainId)));
  const assets = await Promise.all(
    held.slice(0, 40).map(async (b): Promise<WalletAsset> => {
      const amount = Number(formatUnits(BigInt(b.amount), Number(b.decimals)));
      const price = await getJson<{ priceUSD?: string }>(`${LIFI}/token?chain=${b.chainId}&token=${b.address}`).then((t) => Number(t.priceUSD ?? 0) || null).catch(() => null);
      return { chainId: Number(b.chainId), chainName: known.get(Number(b.chainId))!.name, symbol: b.symbol, token: b.address, decimals: Number(b.decimals), amount, usd: price === null ? null : amount * price, native: b.address === NATIVE };
    }),
  );
  return assets.filter((a) => a.usd !== null && a.usd >= MIN_ASSET_USD).sort((x, y) => (y.usd ?? 0) - (x.usd ?? 0));
}

function quote(args: { chainId: number; token: string; amount: bigint; address: string }) {
  const q = new URLSearchParams({ fromChain: String(args.chainId), toChain: String(TEMPO_ID), fromToken: args.token, toToken: OUSD_TEMPO, fromAmount: args.amount.toString(), fromAddress: args.address, toAddress: args.address, integrator: INTEGRATOR, slippage: "0.01" });
  return getJson<LifiQuote>(`${LIFI}/quote?${q}`);
}

/**
 * Convert one token of the agent wallet to OUSD on Tempo. The OUSD arrives in the same agent wallet.
 * An ERC-20 moves in full. A native token keeps a part for gas.
 */
export async function convertToOusd(userId: string, args: { chainId: number; token: string }) {
  const account = await walletAccount(userId);
  const chain = await viemChain(args.chainId);
  const reader = createPublicClient({ chain, transport: http() });
  const signer = createWalletClient({ account, chain, transport: http() });
  const native = args.token.toLowerCase() === NATIVE;
  const nativeBalance = await reader.getBalance({ address: account.address });
  const balance = native ? nativeBalance : await reader.readContract({ address: args.token as Address, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
  const amount = native ? (balance * BigInt(Math.round((1 - NATIVE_KEEP) * 1000))) / 1000n : balance;
  if (amount <= 0n) throw new Error("The agent wallet does not hold this token.");

  const q = await quote({ chainId: args.chainId, token: args.token, amount, address: account.address });
  const tx = q.transactionRequest;
  const gasCost = BigInt(tx.gasLimit ?? 0) * BigInt(tx.gasPrice ?? 0);
  const needed = gasCost + (native ? amount : 0n);
  if (nativeBalance < needed) throw new Error(`The agent wallet needs more ${chain.nativeCurrency.symbol} on ${chain.name} for gas. It holds ${formatUnits(nativeBalance, 18)} and the route needs about ${formatUnits(needed, 18)}.`);

  const hashes: string[] = [];
  if (!native && q.estimate.approvalAddress) {
    const spender = q.estimate.approvalAddress as Address;
    const allowance = await reader.readContract({ address: args.token as Address, abi: erc20Abi, functionName: "allowance", args: [account.address, spender] });
    if (allowance < amount) {
      const approve = await signer.writeContract({ address: args.token as Address, abi: erc20Abi, functionName: "approve", args: [spender, amount] });
      const r = await reader.waitForTransactionReceipt({ hash: approve, timeout: 120_000 });
      if (r.status !== "success") throw new Error(`The approval ${approve} reverted.`);
      hashes.push(approve);
    }
  }
  const hash = await signer.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value ?? 0), gas: tx.gasLimit ? BigInt(tx.gasLimit) : undefined });
  const receipt = await reader.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== "success") throw new Error(`The route transaction ${hash} reverted.`);
  hashes.push(hash);
  const explorer = chain.blockExplorers?.default.url;
  return { hash, hashes, explorer: explorer ? `${explorer}/tx/${hash}` : null, tool: q.tool, expectedOusd: Number(formatUnits(BigInt(q.estimate.toAmount), 6)), etaSeconds: q.estimate.executionDuration ?? null, status: `https://scan.li.fi/tx/${hash}` };
}
