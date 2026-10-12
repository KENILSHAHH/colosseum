// Aave v4 adapter. Aave v4 is live on Ethereum mainnet (hub and spoke design).
// Everything comes from the official AaveKit GraphQL API: https://api.aave.com/graphql (docs: https://aave.com/docs).
// The API gives the markets, the positions and the ready transactions, so no address is written in this file.
import type { Address, Hex } from "viem";
import type { EvmTx } from "./evm";

const API = "https://api.aave.com/graphql";
export const AAVE_V4_CHAIN_ID = 1;

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(20_000) });
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (!res.ok || body.errors?.length || !body.data) throw new Error(`Aave v4 API: ${body.errors?.map((e) => e.message).join("; ") ?? `status ${res.status}`}`);
  return body.data;
}

export interface V4Reserve {
  /** Pass this id to the action functions. */
  id: string;
  spoke: string; spokeAddress: string; hub: string; symbol: string; token: string; decimals: number;
  /** Percent values: 3.99 means 3.99%. */
  supplyApyPct: number; borrowApyPct: number; collateralFactorPct: number; suppliedUsd: number;
  canSupply: boolean; canBorrow: boolean; canUseAsCollateral: boolean;
}

/** Live Aave v4 reserves on Ethereum. A token can be in several spokes, with a different rate and risk in each one. */
export async function listReserves(filter: { asset?: string; spoke?: string } = {}): Promise<V4Reserve[]> {
  const d = await gql<{ reserves: any[] }>(
    `query($r: ReservesRequest!) { reserves(request: $r) {
      id canSupply canBorrow canUseAsCollateral
      spoke { name address }
      asset { hub { name } underlying { address info { symbol decimals } } }
      summary { supplyApy { normalized } borrowApy { normalized } supplied { exchange(currency: USD) { value } } }
      settings { collateralFactor { normalized } }
    } }`,
    { r: { query: { chainIds: [AAVE_V4_CHAIN_ID] }, filter: "ALL", orderBy: { supplyAvailable: "DESC" } } },
  );
  const rows = d.reserves.map((r): V4Reserve => ({
    id: r.id, spoke: r.spoke.name, spokeAddress: r.spoke.address, hub: r.asset.hub.name,
    symbol: r.asset.underlying.info.symbol, token: r.asset.underlying.address, decimals: r.asset.underlying.info.decimals,
    // `normalized` is the percent value in the API.
    supplyApyPct: Number(r.summary.supplyApy.normalized), borrowApyPct: Number(r.summary.borrowApy.normalized), collateralFactorPct: Number(r.settings.collateralFactor.normalized),
    suppliedUsd: Number(r.summary.supplied.exchange.value),
    canSupply: r.canSupply, canBorrow: r.canBorrow, canUseAsCollateral: r.canUseAsCollateral,
  }));
  const asset = filter.asset?.toLowerCase();
  const spoke = filter.spoke?.toLowerCase();
  return rows.filter((r) => (!asset || r.symbol.toLowerCase() === asset) && (!spoke || r.spoke.toLowerCase().includes(spoke)));
}

export interface V4Position { spoke: string; spokeAddress: string; suppliedUsd: number; collateralUsd: number; debtUsd: number; healthFactor: number | null; netApyPct: number; collateralFactorPct: number }

/** One position for each spoke the user is in. The health factor is separate for each spoke. */
export async function getPositions(user: string): Promise<V4Position[]> {
  const d = await gql<{ userPositions: any[] }>(
    `query($r: UserPositionsRequest!) { userPositions(request: $r) {
      spoke { name address }
      totalSupplied(currency: USD) { current { value } }
      totalCollateral(currency: USD) { current { value } }
      totalDebt(currency: USD) { current { value } }
      healthFactor { current }
      netApy { normalized }
      averageCollateralFactor { normalized }
    } }`,
    { r: { user, filter: { chainIds: [AAVE_V4_CHAIN_ID] }, orderBy: { balance: "DESC" } } },
  );
  return d.userPositions.map((p) => ({
    spoke: p.spoke.name, spokeAddress: p.spoke.address,
    suppliedUsd: Number(p.totalSupplied.current.value), collateralUsd: Number(p.totalCollateral.current.value), debtUsd: Number(p.totalDebt.current.value),
    healthFactor: p.healthFactor.current === null ? null : Number(p.healthFactor.current), netApyPct: Number(p.netApy.normalized), collateralFactorPct: Number(p.averageCollateralFactor.normalized),
  }));
}

export type V4Action = "supply" | "borrow" | "withdraw" | "repay";

const TX = `to data value chainId`;
const PLAN = `
  __typename
  ... on TransactionRequest { ${TX} }
  ... on Erc20ApprovalRequired { reason approvals { byTransaction { ${TX} } } originalTransaction { ${TX} } }
  ... on PreContractActionRequired { reason transaction { ${TX} } originalTransaction { ${TX} } }
  ... on InsufficientBalanceError { required { value } available { value } }`;

interface ApiTx { to: Address; data: Hex; value: string | number; chainId: number }
const toTx = (t: ApiTx, description: string): EvmTx => ({ to: t.to, data: t.data, value: BigInt(t.value).toString(), description });

/**
 * Build the transactions for one Aave v4 action, in the order to send them. The API adds the token approval when it is needed.
 * `amount` is in whole tokens ("12.5"). `max` withdraws or repays the full balance. `native` uses ETH for a WETH reserve.
 */
export async function buildAction(args: { action: V4Action; reserveId: string; amount: string; sender: string; native?: boolean; max?: boolean }): Promise<EvmTx[]> {
  const kind = args.native ? "native" : "erc20";
  const exact = { exact: args.amount };
  const amount =
    args.action === "supply" ? { [kind]: args.native ? args.amount : { value: args.amount } }
    : args.action === "borrow" ? { [kind]: args.native ? args.amount : { value: args.amount } }
    : args.action === "withdraw" ? { [kind]: args.max ? { max: true } : exact }
    : { [kind]: args.native ? (args.max ? { max: true } : exact) : { value: args.max ? { max: true } : exact } };
  const type = { supply: "SupplyRequest", borrow: "BorrowRequest", withdraw: "WithdrawRequest", repay: "RepayRequest" }[args.action];
  const d = await gql<Record<string, any>>(`query($r: ${type}!) { plan: ${args.action}(request: $r) { ${PLAN} } }`, { r: { reserve: args.reserveId, amount, sender: args.sender } });
  const plan = d.plan;
  const label = `Aave v4 ${args.action} ${args.max ? "all" : args.amount}`;
  switch (plan.__typename) {
    case "TransactionRequest":
      return [toTx(plan, label)];
    case "Erc20ApprovalRequired":
      return [...plan.approvals.map((a: { byTransaction: ApiTx }) => toTx(a.byTransaction, `Approve the token for Aave v4 (${plan.reason})`)), toTx(plan.originalTransaction, label)];
    case "PreContractActionRequired":
      return [toTx(plan.transaction, `Aave v4 setup (${plan.reason})`), toTx(plan.originalTransaction, label)];
    case "InsufficientBalanceError":
      throw new Error(`The wallet holds ${plan.available.value} and the action needs ${plan.required.value}.`);
    default:
      throw new Error(`Aave v4 API returned an unknown plan type: ${plan.__typename}`);
  }
}
