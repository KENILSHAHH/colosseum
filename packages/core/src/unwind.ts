// Close an Aave v4 position in one transaction through the shared FlashExecutor. Everything is read when it runs,
// so a scheduled job uses the debt, the collateral and the swap route of that moment.
//
// 1. Flash-borrow a little more than the debt (Morpho, no fee; else Aave v3).
// 2. The executor sends it to the wallet. The wallet approves the Spoke and repays all.
// 3. The wallet withdraws all of the collateral and sends it to the executor.
// 4. The executor swaps just enough collateral for the loan (an exact-output route from LI.FI). The loan is repaid.
// 5. The rest of the collateral and of the debt token goes back to the wallet.
// The wallet acts through a permission whose delegate is the executor: Spoke repay and withdraw, approve and transfer on the two tokens.
import { encodeFunctionData, erc20Abi, maxUint256, parseAbi, type Address, type Hex } from "viem";
import { aaveBook } from "./adapters/aave";
import type { EvmTx } from "./adapters/evm";
import { getJson } from "./adapters/http";
import { executorPermissions, getLinkedWallet, permissionContext } from "./delegation";
import { buildFlashRun, coversCall, executorAddress, MORPHO, type FlashStep } from "./flashExecutor";
import { CHAINS } from "./registry/chains";
import { ensureUpgraded } from "./sponsor";
import { getOrCreateWallet, publicClient } from "./wallet";

const spokeAbi = parseAbi(["function repay(uint256 reserveId, uint256 amount, address onBehalfOf) returns (uint256, uint256)", "function withdraw(uint256 reserveId, uint256 amount, address onBehalfOf) returns (uint256, uint256)"]);
const AAVE_V3_PREMIUM_BPS = 5n;

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

/** Build the one transaction that closes the position. The agent wallet sends it. */
export async function buildAaveV4Unwind(userId: string, args: { chain: "ethereum" | "base"; wallet: "agent" | "linked"; spoke?: string; slippageBps?: number }): Promise<{ tx: EvmTx; summary: string }> {
  const chainId = CHAINS[args.chain].chainId!;
  const owner = (args.wallet === "linked" ? await getLinkedWallet(userId) : (await getOrCreateWallet(userId)).address) as Address | null;
  if (!owner) throw new Error("The user has no linked wallet.");
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
  const morpho = MORPHO[args.chain];
  const morphoHolds = morpho ? await reader.readContract({ address: debt.token, abi: erc20Abi, functionName: "balanceOf", args: [morpho] }) : 0n;
  const lender = morpho && morphoHolds >= loan ? ("morpho" as const) : ("aave_v3" as const);
  const owed = lender === "morpho" ? loan : loan + (loan * AAVE_V3_PREMIUM_BPS) / 10_000n + 1n;

  // An exact-output route: just enough collateral to repay the loan.
  const q = await getJson<{ tool: string; estimate: { fromAmount: string; approvalAddress?: string }; transactionRequest: { to: Address; data: Hex; value?: string } }>(
    `https://li.quest/v1/quote/toAmount?${new URLSearchParams({ fromChain: String(chainId), toChain: String(chainId), fromToken: col.token, toToken: debt.token, toAmount: owed.toString(), fromAddress: executor, toAddress: executor, slippage: String((args.slippageBps ?? 100) / 10_000), integrator: "payi" })}`,
  );
  const sell = BigInt(q.estimate.fromAmount);
  if (sell > col.amount) throw new Error(`The collateral (${col.amount} of ${col.symbol}) is not enough to repay the debt through a swap.`);

  const allowance = await reader.readContract({ address: debt.token, abi: erc20Abi, functionName: "allowance", args: [owner, debt.spoke] });
  const steps: FlashStep[] = [
    { from: "executor", to: debt.token, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [owner, loan] }), description: `send ${debt.symbol} to the wallet` },
    // USDT refuses a new non-zero allowance when one is set.
    ...(allowance > 0n ? [{ from: args.wallet, to: debt.token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [debt.spoke, 0n] }), description: "reset the allowance" } as FlashStep] : []),
    { from: args.wallet, to: debt.token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [debt.spoke, loan] }), description: `approve the ${debt.spokeName} spoke` },
    { from: args.wallet, to: debt.spoke, data: encodeFunctionData({ abi: spokeAbi, functionName: "repay", args: [debt.reserveId, maxUint256, owner] }), description: `repay all ${debt.symbol}` },
    { from: args.wallet, to: col.spoke, data: encodeFunctionData({ abi: spokeAbi, functionName: "withdraw", args: [col.reserveId, maxUint256, owner] }), description: `withdraw all ${col.symbol}` },
    { from: args.wallet, to: col.token, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [executor, col.amount] }), description: `send ${col.symbol} to the executor` },
    { from: "executor", to: col.token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [(q.estimate.approvalAddress ?? q.transactionRequest.to) as Address, sell] }), description: "approve the swap" },
    { from: "executor", to: q.transactionRequest.to, value: BigInt(q.transactionRequest.value ?? 0).toString(), data: q.transactionRequest.data, description: `swap ${col.symbol} for ${debt.symbol} via ${q.tool}` },
  ];
  if (args.wallet === "agent") await ensureUpgraded(userId, args.chain);
  const perms = args.wallet === "linked" ? await executorPermissions(userId, args.chain) : [];
  const tx = await buildFlashRun(userId, {
    chain: args.chain, lender, token: debt.token, amount: loan.toString(), steps, sweep: [debt.token, col.token], recipient: owner,
    linkedPermission: async (s) => {
      const p = perms.find((x) => coversCall(x, s));
      if (!p) throw new Error(`No active permission lets the executor call ${s.to} (${s.data.slice(0, 10)}) for the linked wallet. Ask for one with delegate ${executor}: Spoke repay(uint256,uint256,address) and withdraw(uint256,uint256,address), and approve(address,uint256) and transfer(address,uint256) on ${debt.symbol} and ${col.symbol}.`);
      return { wallet: owner, permission: (await permissionContext(p.id, userId)).permissionContext as Hex };
    },
  });
  const summary = `Close the Aave v4 ${debt.spokeName} position: repay ${debt.amount} units of ${debt.symbol} with a ${lender} flash loan, withdraw ${col.amount} units of ${col.symbol}, sell about ${sell} units for the loan, return the rest to ${owner}.`;
  return { tx: { ...tx, description: summary.slice(0, 300) }, summary };
}

export const aaveV3PoolFor = (chain: "ethereum" | "base") => aaveBook(chain).POOL as Address;
