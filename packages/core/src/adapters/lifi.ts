// LI.FI, the routing API behind jumper.xyz. Docs: https://docs.li.fi/api-reference/introduction
// It moves any token on any supported EVM chain to OUSD on Tempo. The agent wallet signs the transactions.
import { createPublicClient, createWalletClient, defineChain, erc20Abi, formatUnits, http, parseUnits, type Account, type Address, type Hex } from "viem";
import { getJson } from "./http";

const LIFI = "https://li.quest/v1";
const INTEGRATOR = "payi";
const NATIVE = "0x0000000000000000000000000000000000000000";
export const TEMPO_ID = 4217;
/** OUSD (OpenUSD) on Tempo, 6 decimals. LI.FI lists it at `GET /v1/tokens?chains=4217`. */
export const OUSD_TEMPO = "0x20c0000000000000000000006a37DA5C996874BE";
/** Assets below this value are not shown. A route for them costs more than it moves. */
const MIN_ASSET_USD = 0.25;
/** A native token keeps this many times the gas cost of the route in the wallet. */
const GAS_RESERVE_FACTOR = 3n;

/** Thrown when the wallet has no native token to pay the gas of a route. */
export class NeedsGasError extends Error {}
/** Thrown when the balance is zero or too small to move. Not a failure: there is nothing to do. */
export class NothingToConvertError extends Error {}

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
export async function walletAssets(address: string, minUsd = MIN_ASSET_USD): Promise<WalletAsset[]> {
  const [res, known] = await Promise.all([getJson<{ balances: Record<string, LifiBalance[]> }>(`${LIFI}/wallets/${address}/balances`), chains()]);
  const held = Object.values(res.balances).flat().filter((b) => BigInt(b.amount) > 0n && Number(b.chainId) !== TEMPO_ID && b.verificationStatus !== "unverified" && known.has(Number(b.chainId)));
  const assets = await Promise.all(
    held.slice(0, 40).map(async (b): Promise<WalletAsset> => {
      const amount = Number(formatUnits(BigInt(b.amount), Number(b.decimals)));
      const price = await getJson<{ priceUSD?: string }>(`${LIFI}/token?chain=${b.chainId}&token=${b.address}`).then((t) => Number(t.priceUSD ?? 0) || null).catch(() => null);
      return { chainId: Number(b.chainId), chainName: known.get(Number(b.chainId))!.name, symbol: b.symbol, token: b.address, decimals: Number(b.decimals), amount, usd: price === null ? null : amount * price, native: b.address === NATIVE };
    }),
  );
  return assets.filter((a) => a.usd !== null && a.usd >= minUsd).sort((x, y) => (y.usd ?? 0) - (x.usd ?? 0));
}

function quote(args: { chainId: number; token: string; amount: bigint; from: string; to: string }) {
  const q = new URLSearchParams({ fromChain: String(args.chainId), toChain: String(TEMPO_ID), fromToken: args.token, toToken: OUSD_TEMPO, fromAmount: args.amount.toString(), fromAddress: args.from, toAddress: args.to, integrator: INTEGRATOR, slippage: "0.01" });
  return getJson<LifiQuote>(`${LIFI}/quote?${q}`);
}

/** Gas cost of a route at the higher of the quoted gas price and the fee cap the wallet will use. */
const gasCostOf = (q: LifiQuote, feeCap: bigint) => {
  const quoted = BigInt(q.transactionRequest.gasPrice ?? 0);
  return BigInt(q.transactionRequest.gasLimit ?? 0) * (feeCap > quoted ? feeCap : quoted);
};

/**
 * Convert the full balance of one token to OUSD on Tempo. `account` signs. The OUSD arrives at `toAddress`.
 * An ERC-20 moves in full. A native token keeps a reserve for gas.
 */
export async function convertToOusd(account: Account, args: { chainId: number; token: string; toAddress: string; rpcUrl?: string }) {
  const chain = await viemChain(args.chainId);
  // `rpcUrl` replaces the public RPC of the chain, for a paid endpoint or a local fork.
  const reader = createPublicClient({ chain, transport: http(args.rpcUrl) });
  const signer = createWalletClient({ account, chain, transport: http(args.rpcUrl) });
  const native = args.token.toLowerCase() === NATIVE;
  const nativeBalance = await reader.getBalance({ address: account.address });
  const balance = native ? nativeBalance : await reader.readContract({ address: args.token as Address, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
  if (balance <= 0n) throw new NothingToConvertError("The wallet does not hold this token.");

  // The wallet checks its balance against gas limit times the fee cap, so the reserve uses the same fee cap.
  const feeCap = await reader.estimateFeesPerGas().then((f) => f.maxFeePerGas ?? f.gasPrice ?? 0n).catch(() => 0n);
  let amount = balance;
  if (native) {
    // A first quote gives the gas cost. The amount is the balance less a reserve for that gas.
    const probe = await quote({ chainId: args.chainId, token: args.token, amount: balance / 2n, from: account.address, to: args.toAddress });
    amount = balance - gasCostOf(probe, feeCap) * GAS_RESERVE_FACTOR;
    if (amount <= 0n) throw new NothingToConvertError(`The ${chain.nativeCurrency.symbol} balance on ${chain.name} is only enough for gas.`);
  }
  const q = await quote({ chainId: args.chainId, token: args.token, amount, from: account.address, to: args.toAddress });
  const tx = q.transactionRequest;
  const needed = gasCostOf(q, feeCap) + (native ? amount : 0n);
  if (nativeBalance < needed) throw new NeedsGasError(`The wallet needs ${chain.nativeCurrency.symbol} on ${chain.name} for gas. It holds ${formatUnits(nativeBalance, 18)} and the route needs about ${formatUnits(needed, 18)}.`);

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

/** Chains and tokens offered in the deposit window. LI.FI resolves each symbol to its address. */
export const DEPOSIT_CHAINS = [8453, 42161, 1, 10, 137, 56] as const;
export const DEPOSIT_SYMBOLS = ["native", "USDC", "USDT", "WBTC", "DAI", "WETH"] as const;

/**
 * A route for a deposit that the user sends from an own wallet: any listed token to OUSD on Tempo, delivered to `toAddress`.
 * The browser sends the approval (when needed) and the transaction. The server signs nothing.
 */
export async function depositQuote(args: { chainId: number; symbol: string; amount: string; from: string; toAddress: string }) {
  const chain = await viemChain(args.chainId);
  const token = await getJson<{ address: string; symbol: string; decimals: number; priceUSD?: string }>(`${LIFI}/token?chain=${args.chainId}&token=${args.symbol === "native" ? NATIVE : args.symbol}`);
  const amount = parseUnits(args.amount, token.decimals);
  if (amount <= 0n) throw new Error("Enter an amount above zero.");
  const q = await quote({ chainId: args.chainId, token: token.address, amount, from: args.from, to: args.toAddress });
  const native = token.address === NATIVE;
  let approval: { token: string; spender: string; amount: string } | null = null;
  if (!native && q.estimate.approvalAddress) {
    const allowance = await createPublicClient({ chain, transport: http() }).readContract({ address: token.address as Address, abi: erc20Abi, functionName: "allowance", args: [args.from as Address, q.estimate.approvalAddress as Address] });
    if (allowance < amount) approval = { token: token.address, spender: q.estimate.approvalAddress, amount: amount.toString() };
  }
  return {
    chainId: args.chainId, chainName: chain.name, symbol: token.symbol, tool: q.tool, approval,
    transaction: { to: q.transactionRequest.to, data: q.transactionRequest.data, value: `0x${BigInt(q.transactionRequest.value ?? 0).toString(16)}` },
    expectedOusd: Number(formatUnits(BigInt(q.estimate.toAmount), 6)), minOusd: Number(formatUnits(BigInt(q.estimate.toAmountMin), 6)), etaSeconds: q.estimate.executionDuration ?? null,
  };
}
