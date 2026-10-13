// Close an Aave position in one transaction through the shared FlashExecutor. Everything is read when it runs,
// so a scheduled job uses the debt, the collateral and the swap route of that moment.
//
// 1. Flash-borrow a little more than the debt (Morpho, no fee; else Aave v3 with its premium).
// 2. The executor sends it to the wallet. The wallet approves the Pool (v3) or the Spoke (v4) and repays all.
// 3. The wallet withdraws the collateral to the executor (v3 sends it there directly; v4 withdraws, then transfers).
// 4. The executor swaps just enough collateral for the loan (an exact-output route from LI.FI). The loan is repaid.
// 5. The rest of the collateral and of the debt token goes back to the wallet.
// The agent wallet acts through a one-hour permission that the server signs for exactly these calls. The linked wallet acts
// through a permission whose delegate is the executor.
import { encodeFunctionData, erc20Abi, maxUint256, parseAbi, type Address, type Hex } from "viem";
import { aaveBook, poolAbi, type AaveChain } from "./adapters/aave";
import type { EvmTx } from "./adapters/evm";
import { getJson } from "./adapters/http";
import { executorPermissions, getLinkedWallet, permissionContext, type DelegationChain } from "./delegation";
import { buildFlashRun, coversCall, executorAddress, MORPHO, type ExecutorChain, type FlashStep } from "./flashExecutor";
import { CHAINS } from "./registry/chains";
import { ensureUpgraded } from "./sponsor";
import { getOrCreateWallet, publicClient } from "./wallet";

const spokeAbi = parseAbi(["function repay(uint256 reserveId, uint256 amount, address onBehalfOf) returns (uint256, uint256)", "function withdraw(uint256 reserveId, uint256 amount, address onBehalfOf) returns (uint256, uint256)"]);
const premiumAbi = parseAbi(["function FLASHLOAN_PREMIUM_TOTAL() view returns (uint128)", "function getReservesList() view returns (address[])"]);
const dataProviderAbi = parseAbi([
  "function getUserReserveData(address asset, address user) view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)",
  "function getReserveTokensAddresses(address asset) view returns (address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress)",
]);
const oracleAbi = parseAbi(["function getAssetPrice(address asset) view returns (uint256)"]);
const symbolAbi = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;
/** Used when the Pool does not answer FLASHLOAN_PREMIUM_TOTAL. Read on-chain on 2026-10-16: 5 on Arbitrum and Base. */
const AAVE_V3_PREMIUM_BPS_FALLBACK = 5n;
/**
 * On-chain DEX aggregators only. The swap runs inside the flash loan, so it must settle in the same transaction.
 * An RFQ quote (nordstern, bebop) is signed for another state and fails there, and an intent route (lifiIntentsDex) fills later.
 */
const ONCHAIN_EXCHANGES = "kyberswap,1inch,sushiswap,paraswap,openocean,lifidexaggregator,dodo";

interface Leg { reserveId: bigint; token: Address; symbol: string; amount: bigint; spoke: Address; spokeName: string }

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch("https://api.aave.com/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(20_000) });
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (!body.data) throw new Error(`Aave v4 API: ${body.errors?.map((e) => e.message).join("; ") ?? res.status}`);
  return body.data;
}

/** The debt and the collateral of a wallet in one spoke, in token units, from the Aave API. */
export async function readLegs(owner: string, chainId: number, spoke?: string): Promise<{ debts: Leg[]; collaterals: Leg[] }> {
  const R = `reserve { onChainId spoke { name address } asset { underlying { address info { symbol } } } }`;
  const user = { userChains: { user: owner, chainIds: [chainId] } };
  const [b, s] = await Promise.all([
    gql<{ userBorrows: any[] }>(`query($r: UserBorrowsRequest!) { userBorrows(request: $r) { ${R} debt { amount { onChainValue } } } }`, { r: { query: user, orderBy: { amount: "DESC" }, includeZeroBalances: false } }),
    gql<{ userSupplies: any[] }>(`query($r: UserSuppliesRequest!) { userSupplies(request: $r) { ${R} withdrawable { amount { onChainValue } } isCollateral } }`, { r: { query: user, orderBy: { amount: "DESC" }, includeZeroBalances: false } }),
  ]);
  const want = spoke?.toLowerCase();
  const leg = (x: any, amount: string): Leg => ({ reserveId: BigInt(x.reserve.onChainId), token: x.reserve.asset.underlying.address, symbol: x.reserve.asset.underlying.info.symbol, amount: BigInt(amount), spoke: x.reserve.spoke.address, spokeName: x.reserve.spoke.name });
  const inSpoke = (x: any) => !want || x.reserve.spoke.name.toLowerCase() === want || x.reserve.spoke.address.toLowerCase() === want;
  return {
    debts: b.userBorrows.filter(inSpoke).map((x) => leg(x, x.debt.amount.onChainValue)),
    collaterals: s.userSupplies.filter(inSpoke).map((x) => leg(x, x.withdrawable.amount.onChainValue)),
  };
}

/** The owner of the position: the agent wallet or the user's linked wallet. */
async function ownerOf(userId: string, wallet: "agent" | "linked"): Promise<Address> {
  const owner = wallet === "linked" ? await getLinkedWallet(userId) : (await getOrCreateWallet(userId)).address;
  if (!owner) throw new Error("The user has no linked wallet.");
  return owner as Address;
}

/** Morpho when it holds enough of the token (no fee). Else Aave v3, with the premium read from the Pool. */
async function pickLender(chain: ExecutorChain, token: Address, loan: bigint): Promise<{ lender: "morpho" | "aave_v3"; owed: bigint }> {
  const reader = publicClient(chain);
  const morpho = MORPHO[chain];
  const morphoHolds = morpho ? await reader.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [morpho] }).catch(() => 0n) : 0n;
  if (morpho && morphoHolds >= loan) return { lender: "morpho", owed: loan };
  if (chain === "robinhood") throw new Error("No flash-loan source on Robinhood Chain holds enough of the debt token.");
  const pool = aaveBook(chain).POOL as Address;
  const premium = await reader.readContract({ address: pool, abi: premiumAbi, functionName: "FLASHLOAN_PREMIUM_TOTAL" }).then(BigInt).catch(() => AAVE_V3_PREMIUM_BPS_FALLBACK);
  return { lender: "aave_v3", owed: loan + (loan * premium + 9_999n) / 10_000n };
}

/** An exact-output route from the executor to the executor: just enough `fromToken` to get `toAmount` of `toToken` after slippage. */
async function exactOutSwap(chainId: number, fromToken: Address, toToken: Address, toAmount: bigint, slippageBps: number) {
  const executor = executorAddress();
  const q = await getJson<{ tool: string; estimate: { fromAmount: string; toAmountMin: string; approvalAddress?: string }; transactionRequest: { to: Address; data: Hex; value?: string } }>(
    `https://li.quest/v1/quote/toAmount?${new URLSearchParams({ fromChain: String(chainId), toChain: String(chainId), fromToken, toToken, toAmount: toAmount.toString(), fromAddress: executor, toAddress: executor, slippage: String(slippageBps / 10_000), integrator: "payi", allowExchanges: ONCHAIN_EXCHANGES })}`,
    { timeoutMs: 25_000 },
  );
  if (BigInt(q.estimate.toAmountMin) < toAmount) throw new Error(`The swap route gives at least ${q.estimate.toAmountMin}, less than the ${toAmount} the loan needs.`);
  return { tool: q.tool, sell: BigInt(q.estimate.fromAmount), approval: (q.estimate.approvalAddress ?? q.transactionRequest.to) as Address, to: q.transactionRequest.to, data: q.transactionRequest.data, value: BigInt(q.transactionRequest.value ?? 0).toString() };
}

/** A permission lookup for the steps of the linked wallet: an active permission whose delegate is the executor. */
async function linkedPermissionFor(userId: string, chain: DelegationChain, owner: Address, need: string) {
  const perms = await executorPermissions(userId, chain);
  return async (s: FlashStep) => {
    const p = perms.find((x) => coversCall(x, s));
    if (!p) throw new Error(`No active permission lets the executor call ${s.to} (${s.data.slice(0, 10)}) for the linked wallet. Ask for one with delegate ${executorAddress()}: ${need}`);
    return { wallet: owner, permission: (await permissionContext(p.id, userId)).permissionContext as Hex };
  };
}

/** Build the one transaction that closes the position. The agent wallet sends it. */
export async function buildAaveV4Unwind(userId: string, args: { chain: "ethereum" | "base"; wallet: "agent" | "linked"; spoke?: string; slippageBps?: number }): Promise<{ tx: EvmTx; summary: string }> {
  const chainId = CHAINS[args.chain].chainId!;
  const owner = await ownerOf(userId, args.wallet);
  const { debts, collaterals } = await readLegs(owner, chainId, args.spoke);
  if (debts.length === 0) throw new Error("This wallet has no Aave v4 debt in that spoke. Nothing to unwind.");
  const spokes = new Set([...debts, ...collaterals].map((l) => l.spoke.toLowerCase()));
  if (spokes.size !== 1) throw new Error("The position is in several spokes. Name the spoke to unwind.");
  if (debts.length !== 1) throw new Error("The position has more than one debt token. Unwind it in steps with flash_run.");
  const debt = debts[0]!;
  const col = collaterals.filter((c) => c.token.toLowerCase() !== debt.token.toLowerCase()).sort((x, y) => (y.amount > x.amount ? 1 : -1))[0];
  if (!col || collaterals.length > 2) throw new Error("The position needs exactly one collateral token for this unwind. Use flash_run for other cases.");

  const executor = executorAddress();
  const reader = publicClient(args.chain);
  // A small margin over the debt: interest grows between this read and the transaction.
  const loan = debt.amount + debt.amount / 500n + 1n;
  const { lender, owed } = await pickLender(args.chain, debt.token, loan);
  const swap = await exactOutSwap(chainId, col.token, debt.token, owed, args.slippageBps ?? 100);
  if (swap.sell > col.amount) throw new Error(`The collateral (${col.amount} of ${col.symbol}) is not enough to repay the debt through a swap.`);

  const allowance = await reader.readContract({ address: debt.token, abi: erc20Abi, functionName: "allowance", args: [owner, debt.spoke] });
  const steps: FlashStep[] = [
    { from: "executor", to: debt.token, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [owner, loan] }), description: `send ${debt.symbol} to the wallet` },
    // USDT refuses a new non-zero allowance when one is set.
    ...(allowance > 0n ? [{ from: args.wallet, to: debt.token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [debt.spoke, 0n] }), description: "reset the allowance" } as FlashStep] : []),
    { from: args.wallet, to: debt.token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [debt.spoke, loan] }), description: `approve the ${debt.spokeName} spoke` },
    { from: args.wallet, to: debt.spoke, data: encodeFunctionData({ abi: spokeAbi, functionName: "repay", args: [debt.reserveId, maxUint256, owner] }), description: `repay all ${debt.symbol}` },
    { from: args.wallet, to: col.spoke, data: encodeFunctionData({ abi: spokeAbi, functionName: "withdraw", args: [col.reserveId, maxUint256, owner] }), description: `withdraw all ${col.symbol}` },
    { from: args.wallet, to: col.token, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [executor, col.amount] }), description: `send ${col.symbol} to the executor` },
    { from: "executor", to: col.token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [swap.approval, swap.sell] }), description: "approve the swap" },
    { from: "executor", to: swap.to, value: swap.value, data: swap.data, description: `swap ${col.symbol} for ${debt.symbol} via ${swap.tool}` },
  ];
  if (args.wallet === "agent") await ensureUpgraded(userId, args.chain);
  const tx = await buildFlashRun(userId, {
    chain: args.chain, lender, token: debt.token, amount: loan.toString(), steps, sweep: [debt.token, col.token], recipient: owner,
    linkedPermission: args.wallet === "linked"
      ? await linkedPermissionFor(userId, args.chain, owner, `Spoke repay(uint256,uint256,address) and withdraw(uint256,uint256,address), and approve(address,uint256) and transfer(address,uint256) on ${debt.symbol} and ${col.symbol}.`)
      : undefined,
  });
  const summary = `Close the Aave v4 ${debt.spokeName} position: repay ${debt.amount} units of ${debt.symbol} with a ${lender} flash loan, withdraw ${col.amount} units of ${col.symbol}, sell about ${swap.sell} units for the loan, return the rest to ${owner}.`;
  return { tx: { ...tx, description: summary.slice(0, 300) }, summary };
}

export interface V3Leg { token: Address; symbol: string; decimals: number; amount: bigint; usd: number; collateral: boolean }

/** The supplies and the debts of a wallet on Aave v3, read on-chain from the Pool, the data provider and the oracle. */
export async function readV3Legs(chain: AaveChain, owner: Address): Promise<{ supplies: V3Leg[]; debts: (V3Leg & { stableDebt: bigint })[] }> {
  const book = aaveBook(chain);
  const reader = publicClient(chain);
  const reserves = await reader.readContract({ address: book.POOL as Address, abi: premiumAbi, functionName: "getReservesList" });
  const data = await reader.multicall({
    multicallAddress: MULTICALL3, allowFailure: false,
    contracts: reserves.map((asset) => ({ address: book.AAVE_PROTOCOL_DATA_PROVIDER as Address, abi: dataProviderAbi, functionName: "getUserReserveData", args: [asset, owner] }) as const),
  });
  const held = reserves.map((token, i) => ({ token, d: data[i] as readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, number, boolean] })).filter((x) => x.d[0] > 0n || x.d[1] > 0n || x.d[2] > 0n);
  if (held.length === 0) return { supplies: [], debts: [] };
  const meta = await reader.multicall({
    multicallAddress: MULTICALL3, allowFailure: false,
    contracts: held.flatMap((x) => [
      { address: x.token, abi: symbolAbi, functionName: "symbol" },
      { address: x.token, abi: symbolAbi, functionName: "decimals" },
      { address: book.ORACLE as Address, abi: oracleAbi, functionName: "getAssetPrice", args: [x.token] },
    ] as const),
  });
  const supplies: V3Leg[] = [];
  const debts: (V3Leg & { stableDebt: bigint })[] = [];
  held.forEach((x, i) => {
    const symbol = meta[i * 3] as string, decimals = Number(meta[i * 3 + 1]), price = Number(meta[i * 3 + 2]) / 1e8;
    const usd = (amount: bigint) => (Number(amount) / 10 ** decimals) * price;
    if (x.d[0] > 0n) supplies.push({ token: x.token, symbol, decimals, amount: x.d[0], usd: usd(x.d[0]), collateral: x.d[8] });
    const owedNow = x.d[1] + x.d[2];
    if (owedNow > 0n) debts.push({ token: x.token, symbol, decimals, amount: owedNow, usd: usd(owedNow), collateral: false, stableDebt: x.d[1] });
  });
  return { supplies, debts };
}

const fmt = (l: V3Leg, amount = l.amount) => `${(Number(amount) / 10 ** l.decimals).toPrecision(6)} ${l.symbol}`;

/**
 * Close an Aave v3 position in one transaction: repay the one debt token with a flash loan, withdraw the collateral that pays
 * for it straight to the executor, sell just enough of it, and return the rest to the wallet. Other deposits stay in Aave.
 * Everything is read now, so a scheduled job that calls this when it fires uses the debt and the route of that moment.
 */
export async function buildAaveV3Unwind(userId: string, args: { chain: AaveChain; wallet: "agent" | "linked"; slippageBps?: number }): Promise<{ tx: EvmTx; summary: string; debtUsd: number }> {
  const chainId = CHAINS[args.chain].chainId!;
  const owner = await ownerOf(userId, args.wallet);
  const { supplies, debts } = await readV3Legs(args.chain, owner);
  if (debts.length === 0) throw new Error(`This wallet (${owner}) has no Aave v3 debt on ${CHAINS[args.chain].name}. Nothing to unwind.`);
  if (debts.length > 1) throw new Error(`The position has ${debts.length} debt tokens (${debts.map((d) => d.symbol).join(", ")}). This unwind repays one. Repay the smaller debts first (swap, then repay), or build the plan with flash_run.`);
  const debt = debts[0]!;
  if (debt.stableDebt > 0n) throw new Error(`The ${debt.symbol} debt has a stable-rate part. This unwind repays variable debt only.`);

  // The collateral that pays: the largest one in USD that covers the debt with room for the swap. The debt token itself pays with no swap.
  const own = supplies.find((s) => s.token.toLowerCase() === debt.token.toLowerCase() && s.amount > debt.amount * 1005n / 1000n);
  const col = own ?? [...supplies].filter((s) => s.collateral && s.token.toLowerCase() !== debt.token.toLowerCase()).sort((x, y) => y.usd - x.usd)[0];
  if (!col) throw new Error(`The wallet has no Aave v3 collateral on ${CHAINS[args.chain].name} to pay the debt.`);
  if (!own && col.usd < debt.usd * 1.02) throw new Error(`No single collateral covers the debt: the largest is ${fmt(col)} (about ${col.usd.toFixed(2)} USD) for a debt of about ${debt.usd.toFixed(2)} USD. Build the plan with flash_run.`);

  const book = aaveBook(args.chain);
  const pool = book.POOL as Address;
  const executor = executorAddress();
  const reader = publicClient(args.chain);
  // A small margin over the debt: interest grows between this read and the transaction. What is not used stays in the wallet.
  const loan = debt.amount + debt.amount / 500n + 1n;
  const { lender, owed } = await pickLender(args.chain, debt.token, loan);
  if (lender === "aave_v3") {
    const [aToken] = await reader.readContract({ address: book.AAVE_PROTOCOL_DATA_PROVIDER as Address, abi: dataProviderAbi, functionName: "getReserveTokensAddresses", args: [debt.token] });
    const free = await reader.readContract({ address: debt.token, abi: erc20Abi, functionName: "balanceOf", args: [aToken] });
    if (free < loan) throw new Error(`Aave v3 has only ${fmt(debt, free)} free to lend for the flash loan, and Morpho does not hold enough. Try again later.`);
  }
  const swap = own ? null : await exactOutSwap(chainId, col.token, debt.token, owed, args.slippageBps ?? 100);
  if (swap && swap.sell > col.amount) throw new Error(`The swap needs ${fmt(col, swap.sell)}, more than the ${fmt(col)} in the position.`);
  if (own && own.amount < owed) throw new Error(`The ${debt.symbol} deposit (${fmt(own)}) does not cover the loan of ${fmt(debt, owed)}.`);

  const allowance = await reader.readContract({ address: debt.token, abi: erc20Abi, functionName: "allowance", args: [owner, pool] });
  const steps: FlashStep[] = [
    { from: "executor", to: debt.token, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [owner, loan] }), description: `send ${debt.symbol} to the wallet` },
    // USDT refuses a new non-zero allowance when one is set.
    ...(allowance > 0n ? [{ from: args.wallet, to: debt.token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [pool, 0n] }), description: "reset the allowance" } as FlashStep] : []),
    { from: args.wallet, to: debt.token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [pool, loan] }), description: "approve the Aave Pool" },
    { from: args.wallet, to: pool, data: encodeFunctionData({ abi: poolAbi, functionName: "repay", args: [debt.token, maxUint256, 2n, owner] }), description: `repay all ${debt.symbol}` },
    // Pool.withdraw sends the tokens to any address, so the collateral goes straight to the executor.
    { from: args.wallet, to: pool, data: encodeFunctionData({ abi: poolAbi, functionName: "withdraw", args: [col.token, maxUint256, executor] }), description: `withdraw all ${col.symbol} to the executor` },
    ...(swap
      ? [
          { from: "executor", to: col.token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [swap.approval, swap.sell] }), description: "approve the swap" } as FlashStep,
          { from: "executor", to: swap.to, value: swap.value, data: swap.data, description: `swap ${col.symbol} for ${debt.symbol} via ${swap.tool}` } as FlashStep,
        ]
      : []),
  ];
  if (args.wallet === "agent") await ensureUpgraded(userId, args.chain);
  const tx = await buildFlashRun(userId, {
    chain: args.chain, lender, token: debt.token, amount: loan.toString(), steps, sweep: [...new Set([debt.token, col.token])], recipient: owner,
    linkedPermission: args.wallet === "linked"
      ? await linkedPermissionFor(userId, args.chain, owner, `Pool ${pool}: repay(address,uint256,uint256,address) and withdraw(address,uint256,address); ${debt.symbol} ${debt.token}: approve(address,uint256).`)
      : undefined,
  });
  const others = supplies.filter((s) => s.token !== col.token);
  const summary = `Close the Aave v3 position on ${CHAINS[args.chain].name}: repay ${fmt(debt)} with a ${lender === "morpho" ? "Morpho (no fee)" : "Aave v3"} flash loan, withdraw ${fmt(col)}${swap ? `, sell about ${fmt(col, swap.sell)} for the loan via ${swap.tool}` : ""}, and return the rest to ${owner}.${others.length ? ` ${others.map((o) => fmt(o)).join(", ")} stay deposited in Aave.` : ""}`;
  return { tx: { ...tx, description: summary.slice(0, 300) }, summary, debtUsd: debt.usd };
}
