// LI.FI, the routing API behind jumper.xyz. Docs: https://docs.li.fi/api-reference/introduction
// It moves any token on any supported EVM chain to OUSD on Tempo. The agent wallet signs the transactions.
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, erc20Abi, formatUnits, http, parseUnits, type Account, type Address, type Hex } from "viem";
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

interface LifiChain { id: number; name: string; coin: string; logoURI?: string; metamask: { rpcUrls: string[]; blockExplorerUrls: string[]; nativeCurrency: { name: string; symbol: string; decimals: number } } }
interface LifiBalance { address: string; symbol: string; decimals: number; amount: string; chainId: number; verificationStatus?: string }
interface LifiQuote {
  tool: string;
  estimate: { toAmount: string; toAmountMin: string; approvalAddress?: string; executionDuration?: number; gasCosts?: { amount: string; amountUSD?: string }[]; feeCosts?: { amountUSD?: string }[] };
  transactionRequest: { to: Address; data: Hex; value?: string; gasLimit?: string; gasPrice?: string; chainId: number };
}

export interface WalletAsset { chainId: number; chainName: string; symbol: string; token: string; decimals: number; amount: number; usd: number | null; native: boolean; logo: string | null; chainLogo: string | null }

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

/** Every token of the address that LI.FI can route, with a USD value. Tempo is not a source for a conversion (the destination is there), so it is left out unless `includeTempo`. */
export async function walletAssets(address: string, minUsd = MIN_ASSET_USD, { includeTempo = false } = {}): Promise<WalletAsset[]> {
  const [res, known] = await Promise.all([getJson<{ balances: Record<string, LifiBalance[]> }>(`${LIFI}/wallets/${address}/balances`), chains()]);
  const held = Object.values(res.balances).flat().filter((b) => BigInt(b.amount) > 0n && (includeTempo || Number(b.chainId) !== TEMPO_ID) && b.verificationStatus !== "unverified" && known.has(Number(b.chainId)));
  const assets = await Promise.all(
    held.slice(0, 40).map(async (b): Promise<WalletAsset> => {
      const amount = Number(formatUnits(BigInt(b.amount), Number(b.decimals)));
      const t = await getJson<{ priceUSD?: string; logoURI?: string }>(`${LIFI}/token?chain=${b.chainId}&token=${b.address}`).catch(() => null);
      const price = Number(t?.priceUSD ?? 0) || null;
      const chain = known.get(Number(b.chainId))!;
      return { chainId: chain.id, chainName: chain.name, symbol: b.symbol, token: b.address, decimals: Number(b.decimals), amount, usd: price === null ? null : amount * price, native: b.address === NATIVE, logo: t?.logoURI || null, chainLogo: chain.logoURI ?? null };
    }),
  );
  return assets.filter((a) => a.usd !== null && a.usd >= minUsd).sort((x, y) => (y.usd ?? 0) - (x.usd ?? 0));
}

/** Chains that the LI.FI balance API does not read: Robinhood Chain (stock tokens) and Tempo. */
export const RPC_READ_CHAINS = [4663, TEMPO_ID] as const;
/**
 * Tokens read from the chain RPC, so a deposit shows at once. The LI.FI balance API is cached for 5 minutes (s-maxage=300).
 * `null` reads every token LI.FI lists on the chain. Other tokens on other chains still come from the LI.FI balance API.
 */
const FAST_READ: Record<number, readonly string[] | null> = {
  4663: null, [TEMPO_ID]: null,
  ...Object.fromEntries([8453, 42161, 1, 10, 137, 56].map((id) => [id, ["ETH", "POL", "BNB", "USDC", "USDC.e", "USDbC", "USDT", "USDT0", "WETH", "WBTC", "cbBTC", "DAI"]])),
};
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;
const multicallAbi = [{ type: "function", name: "getEthBalance", stateMutability: "view", inputs: [{ name: "addr", type: "address" }], outputs: [{ type: "uint256" }] }] as const;
let listCache: Map<number, { at: number; tokens: { address: string; symbol: string; decimals: number; priceUSD?: string; logoURI?: string }[] }> = new Map();

const assetKey = (chainId: number, token: string) => `${chainId}:${token.toLowerCase()}`;

const listLoads = new Map<number, Promise<{ at: number; tokens: { address: string; symbol: string; decimals: number; priceUSD?: string; logoURI?: string }[] }>>();
function loadTokenList(chainId: number) {
  const running = listLoads.get(chainId);
  if (running) return running;
  const job = getJson<{ tokens: Record<string, { address: string; symbol: string; decimals: number; priceUSD?: string; logoURI?: string }[]> }>(`${LIFI}/tokens?chains=${chainId}`)
    .then((res) => {
      const list = { at: Date.now(), tokens: Object.values(res.tokens).flat() };
      listCache.set(chainId, list);
      return list;
    })
    .finally(() => listLoads.delete(chainId));
  listLoads.set(chainId, job);
  return job;
}

/**
 * The tokens of `FAST_READ` that the address holds, read with Multicall3 from the chain RPC. A chain whose RPC fails is left out.
 * The token list, the prices and the logos come from LI.FI (`GET /v1/tokens`). `checked` holds every token that was read,
 * held or not, so a stale LI.FI balance of a token that was spent is not shown again.
 */
async function fastRead(address: string, chainIds: number[]): Promise<{ assets: WalletAsset[]; checked: Set<string> }> {
  const known = await chains();
  const checked = new Set<string>();
  const perChain = await Promise.all(chainIds.map(async (chainId) => {
    const chain = known.get(chainId);
    if (!chain) return [];
    // A stale list is used while a new one loads, so only the first read after a start waits for the list.
    let list = listCache.get(chainId);
    if (!list) list = await loadTokenList(chainId);
    else if (Date.now() - list.at > 600_000) void loadTokenList(chainId).catch(() => {});
    const symbols = FAST_READ[chainId];
    const tokens = symbols ? list.tokens.filter((t) => t.address === NATIVE || symbols.includes(t.symbol)) : list.tokens;
    const client = createPublicClient({ transport: http(chain.metamask.rpcUrls[0]) });
    const results = await client.multicall({
      multicallAddress: MULTICALL3, allowFailure: true,
      contracts: tokens.map((t) => t.address === NATIVE
        ? { address: MULTICALL3, abi: multicallAbi, functionName: "getEthBalance" as const, args: [address as Address] }
        : { address: t.address as Address, abi: erc20Abi, functionName: "balanceOf" as const, args: [address as Address] }),
    }).catch(() => null);
    if (!results) return [];
    return tokens.flatMap((t, i): WalletAsset[] => {
      const r = results[i]!;
      if (r.status !== "success") return [];
      checked.add(assetKey(chainId, t.address));
      if (!(r.result as bigint)) return [];
      const amount = Number(formatUnits(r.result as bigint, t.decimals));
      const price = Number(t.priceUSD ?? 0) || null;
      const logo = t.logoURI && !t.logoURI.endsWith("unknown.svg") ? t.logoURI : null;
      return [{ chainId, chainName: chain.name, symbol: t.symbol, token: t.address, decimals: t.decimals, amount, usd: price === null ? null : amount * price, native: t.address === NATIVE, logo, chainLogo: chain.logoURI ?? null }];
    });
  }));
  return { assets: perChain.flat(), checked };
}

/** Every token of the address on `RPC_READ_CHAINS`, read with Multicall3 from the chain RPC. */
export async function rpcAssets(address: string, minUsd = MIN_ASSET_USD): Promise<WalletAsset[]> {
  const { assets } = await fastRead(address, [...RPC_READ_CHAINS]);
  return assets.filter((a) => a.usd !== null && a.usd >= minUsd).sort((x, y) => (y.usd ?? 0) - (x.usd ?? 0));
}

/**
 * Every token of the address: the RPC read of `FAST_READ`, which is current, plus the LI.FI balance API for other tokens.
 * `includeTempo: false` leaves out Tempo, for a list of tokens to convert. A source that fails is left out; both failing gives null.
 */
export async function allWalletAssets(address: string, minUsd = MIN_ASSET_USD, { includeTempo = true } = {}): Promise<WalletAsset[] | null> {
  const fastChains = Object.keys(FAST_READ).map(Number).filter((id) => includeTempo || id !== TEMPO_ID);
  const [lifi, rpc] = await Promise.all([walletAssets(address, minUsd, { includeTempo }).catch(() => null), fastRead(address, fastChains).catch(() => null)]);
  if (lifi === null && rpc === null) return null;
  const fast = (rpc?.assets ?? []).filter((a) => a.usd !== null && a.usd >= minUsd);
  const seen = new Set([...(rpc?.checked ?? []), ...fast.map((a) => assetKey(a.chainId, a.token))]);
  return [...fast, ...(lifi ?? []).filter((a) => !seen.has(assetKey(a.chainId, a.token)))].sort((x, y) => (y.usd ?? 0) - (x.usd ?? 0));
}

/** LI.FI chain id of Solana, and the address it uses for SOL. */
export const SOLANA_ID = 1151111081099710;
export const SOL_NATIVE = "11111111111111111111111111111111";

/**
 * Convert about `usd` of a Solana token to OUSD on Tempo through LI.FI. `signAndSend` signs the base64 transaction with the
 * Solana wallet `from` and sends it. The OUSD arrives at `toAddress`.
 */
export async function convertSolanaToOusd(signAndSend: (tx: string) => Promise<string>, args: { from: string; mint: string; amount: bigint; toAddress: string }) {
  const q = new URLSearchParams({ fromChain: String(SOLANA_ID), toChain: String(TEMPO_ID), fromToken: args.mint, toToken: OUSD_TEMPO, fromAmount: args.amount.toString(), fromAddress: args.from, toAddress: args.toAddress, integrator: INTEGRATOR, slippage: "0.01" });
  const quoteRes = await getJson<{ tool: string; estimate: { toAmount: string; executionDuration?: number }; transactionRequest: { data: string } }>(`${LIFI}/quote?${q}`);
  const hash = await signAndSend(quoteRes.transactionRequest.data);
  return { hash, tool: quoteRes.tool, expectedOusd: Number(formatUnits(BigInt(quoteRes.estimate.toAmount), 6)), etaSeconds: quoteRes.estimate.executionDuration ?? null, status: `https://scan.li.fi/tx/${hash}` };
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

/** Something that can send calls on a chain: a key that pays its own gas, or a wallet with a gas sponsor. */
export interface Sender {
  address: Address;
  /** True when a sponsor pays the gas on this chain. The wallet then needs no native token. */
  sponsoredOn(chainId: number): boolean;
  /** Send the calls in order and wait for them. Returns the hash of the last transaction. */
  send(chainId: number, calls: { to: Address; data: Hex; value: bigint; gas?: bigint }[]): Promise<Hex>;
}

/** A key as a sender. `rpcUrl` replaces the public RPC of the chain, for a paid endpoint or a local fork. */
export function accountSender(account: Account, rpcUrl?: string): Sender {
  return {
    address: account.address,
    sponsoredOn: () => false,
    async send(chainId, calls) {
      const chain = await viemChain(chainId);
      const reader = createPublicClient({ chain, transport: http(rpcUrl) });
      const signer = createWalletClient({ account, chain, transport: http(rpcUrl) });
      let hash: Hex = "0x";
      for (const c of calls) {
        hash = await signer.sendTransaction({ to: c.to, data: c.data, value: c.value, gas: c.gas });
        const r = await reader.waitForTransactionReceipt({ hash, timeout: 180_000 });
        if (r.status !== "success") throw new Error(`The transaction ${hash} reverted.`);
      }
      return hash;
    },
  };
}

/**
 * Convert one token to OUSD on Tempo. `sender` makes the calls. The OUSD arrives at `toAddress`.
 * Default: the full balance. A native token keeps a reserve for gas when the sender pays its own gas.
 * `maxUsd` converts only about that value and leaves the rest in the wallet.
 */
export async function convertToOusd(sender: Sender, args: { chainId: number; token: string; toAddress: string; rpcUrl?: string; maxUsd?: number }) {
  const chain = await viemChain(args.chainId);
  const reader = createPublicClient({ chain, transport: http(args.rpcUrl) });
  const native = args.token.toLowerCase() === NATIVE;
  const sponsored = sender.sponsoredOn(args.chainId);
  const nativeBalance = await reader.getBalance({ address: sender.address });
  const balance = native ? nativeBalance : await reader.readContract({ address: args.token as Address, abi: erc20Abi, functionName: "balanceOf", args: [sender.address] });
  if (balance <= 0n) throw new NothingToConvertError("The wallet does not hold this token.");

  // The wallet checks its balance against gas limit times the fee cap, so the reserve uses the same fee cap.
  const feeCap = await reader.estimateFeesPerGas().then((f) => f.maxFeePerGas ?? f.gasPrice ?? 0n).catch(() => 0n);
  let amount = balance;
  if (native && !sponsored) {
    // A first quote gives the gas cost. The amount is the balance less a reserve for that gas.
    const probe = await quote({ chainId: args.chainId, token: args.token, amount: balance / 2n, from: sender.address, to: args.toAddress });
    amount = balance - gasCostOf(probe, feeCap) * GAS_RESERVE_FACTOR;
    if (amount <= 0n) throw new NothingToConvertError(`The ${chain.nativeCurrency.symbol} balance on ${chain.name} is only enough for gas.`);
  }
  if (args.maxUsd !== undefined) {
    const info = await getJson<{ decimals: number; priceUSD?: string }>(`${LIFI}/token?chain=${args.chainId}&token=${args.token}`);
    const price = Number(info.priceUSD ?? 0);
    if (!(price > 0)) throw new Error("LI.FI has no price for this token.");
    const part = parseUnits((args.maxUsd / price).toFixed(info.decimals), info.decimals);
    if (part < amount) amount = part;
  }
  const q = await quote({ chainId: args.chainId, token: args.token, amount, from: sender.address, to: args.toAddress });
  const tx = q.transactionRequest;
  if (!sponsored) {
    const needed = gasCostOf(q, feeCap) + (native ? amount : 0n);
    if (nativeBalance < needed) throw new NeedsGasError(`The wallet needs ${chain.nativeCurrency.symbol} on ${chain.name} for gas. It holds ${formatUnits(nativeBalance, 18)} and the route needs about ${formatUnits(needed, 18)}.`);
  }

  const calls: { to: Address; data: Hex; value: bigint; gas?: bigint }[] = [];
  if (!native && q.estimate.approvalAddress) {
    const spender = q.estimate.approvalAddress as Address;
    const allowance = await reader.readContract({ address: args.token as Address, abi: erc20Abi, functionName: "allowance", args: [sender.address, spender] });
    if (allowance < amount) calls.push({ to: args.token as Address, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }), value: 0n });
  }
  calls.push({ to: tx.to, data: tx.data, value: BigInt(tx.value ?? 0), gas: tx.gasLimit ? BigInt(tx.gasLimit) : undefined });
  const hash = await sender.send(args.chainId, calls);
  const explorer = chain.blockExplorers?.default.url;
  return { hash, transactions: calls.length, explorer: explorer ? `${explorer}/tx/${hash}` : null, tool: q.tool, expectedOusd: Number(formatUnits(BigInt(q.estimate.toAmount), 6)), etaSeconds: q.estimate.executionDuration ?? null, status: `https://scan.li.fi/tx/${hash}` };
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

/** Chains where the agent wallet can act, so a token sent there is ready for a position. */
export const TRADING_DEPOSIT_CHAINS = [8453, 42161, 1, 4663, 4217] as const;

/** Tokens a user can deposit on each trading chain, by LI.FI symbol. Robinhood Chain has no USDC; Tempo has no native coin. */
export const TRADING_DEPOSIT_TOKENS: Record<number, readonly string[]> = {
  8453: DEPOSIT_SYMBOLS, 42161: DEPOSIT_SYMBOLS, 1: DEPOSIT_SYMBOLS,
  4663: ["native", "USDG", "USDe", "WETH"],
  4217: ["USDCe", "USDT0", "PathUSD", "OUSD"],
};

/**
 * A plain transfer of a listed token from an own wallet of the user to `toAddress`. The token is not converted.
 * The browser signs it. LI.FI resolves the symbol to its address and decimals on the chain.
 */
export async function depositTransfer(args: { chainId: number; symbol: string; amount: string; toAddress: string }) {
  const chain = await viemChain(args.chainId);
  const token = await getJson<{ address: string; symbol: string; decimals: number }>(`${LIFI}/token?chain=${args.chainId}&token=${args.symbol === "native" ? NATIVE : args.symbol}`);
  const amount = parseUnits(args.amount, token.decimals);
  if (amount <= 0n) throw new Error("Enter an amount above zero.");
  const transaction =
    token.address === NATIVE
      ? { to: args.toAddress, data: "0x", value: `0x${amount.toString(16)}` }
      : { to: token.address, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [args.toAddress as Address, amount] }), value: "0x0" };
  return { chainId: args.chainId, chainName: chain.name, symbol: token.symbol, approval: null, transaction, expectedOusd: null, etaSeconds: null };
}

/** A token by symbol or address on a chain, from LI.FI. */
export async function resolveToken(chainId: number, token: string) {
  const t = await getJson<{ address: string; symbol: string; decimals: number; priceUSD?: string }>(`${LIFI}/token?chain=${chainId}&token=${token === "native" ? NATIVE : token}`);
  return { address: t.address as Address, symbol: t.symbol, decimals: t.decimals, priceUsd: Number(t.priceUSD ?? 0) || null };
}

/**
 * A swap on one chain or a route across chains for any token LI.FI knows (jumper.xyz routes), from `from` to `to`.
 * Returns the calls to send on the source chain: the approval when one is needed, then the route.
 */
/** `exchanges` limits the route to these LI.FI exchange keys (for example on a local fork, where a signed RFQ quote fails). */
export async function routeTransactions(args: { fromChainId: number; toChainId: number; fromToken: string; toToken: string; amount: string; from: string; to: string; slippage?: number; exchanges?: string[] }) {
  const [inTok, outTok] = await Promise.all([resolveToken(args.fromChainId, args.fromToken), resolveToken(args.toChainId, args.toToken)]);
  const amount = parseUnits(args.amount, inTok.decimals);
  if (amount <= 0n) throw new Error("The amount must be above zero.");
  const q = await getJson<LifiQuote>(`${LIFI}/quote?${new URLSearchParams({ fromChain: String(args.fromChainId), toChain: String(args.toChainId), fromToken: inTok.address, toToken: outTok.address, fromAmount: amount.toString(), fromAddress: args.from, toAddress: args.to, integrator: INTEGRATOR, slippage: String(args.slippage ?? 0.005), ...(args.exchanges ? { allowExchanges: args.exchanges.join(",") } : {}) })}`);
  const calls: { to: Address; data: Hex; value: string; description: string }[] = [];
  if (inTok.address !== NATIVE && q.estimate.approvalAddress) {
    const chain = await viemChain(args.fromChainId);
    const allowance = await createPublicClient({ chain, transport: http() }).readContract({ address: inTok.address, abi: erc20Abi, functionName: "allowance", args: [args.from as Address, q.estimate.approvalAddress as Address] });
    if (allowance < amount) calls.push({ to: inTok.address, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [q.estimate.approvalAddress as Address, amount] }), value: "0", description: `Approve ${inTok.symbol}` });
  }
  const outAmount = Number(formatUnits(BigInt(q.estimate.toAmount), outTok.decimals));
  calls.push({ to: q.transactionRequest.to, data: q.transactionRequest.data, value: BigInt(q.transactionRequest.value ?? 0).toString(), description: `${args.fromChainId === args.toChainId ? "Swap" : "Route"} ${args.amount} ${inTok.symbol} to about ${outAmount.toPrecision(6)} ${outTok.symbol} via ${q.tool}` });
  return { calls, tool: q.tool, inToken: inTok, outToken: outTok, outAmount, minOut: Number(formatUnits(BigInt(q.estimate.toAmountMin), outTok.decimals)), usdIn: inTok.priceUsd ? Number(args.amount) * inTok.priceUsd : null, etaSeconds: q.estimate.executionDuration ?? null };
}
