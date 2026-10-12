// Aave v4 adapter (hub and spoke design). Aave v4 runs only on the chains where Aave deployed it.
// Everything comes from the official AaveKit GraphQL API: https://api.aave.com/graphql (docs: https://aave.com/docs).
// The API gives the chains, the markets, the positions and the ready transactions, so no address and no chain list is written in this file.
import type { Address, Hex } from "viem";
import { CHAINS, type ChainKey } from "../registry/chains";
import type { EvmTx } from "./evm";

const API = "https://api.aave.com/graphql";

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(20_000) });
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (!res.ok || body.errors?.length || !body.data) throw new Error(`Aave v4 API: ${body.errors?.map((e) => e.message).join("; ") ?? `status ${res.status}`}`);
  return body.data;
}

export interface V4Chain { chainId: number; name: string; /** The chain key of this product. `null`: the agent can read the chain but cannot send transactions there. */ key: ChainKey | null }

let chainCache: { at: number; chains: V4Chain[] } | undefined;
/** The chains with Aave v4 right now, from the API. A new deployment appears here with no code change. */
export async function v4Chains(): Promise<V4Chain[]> {
  if (!chainCache || Date.now() - chainCache.at > 3_600_000) {
    const d = await gql<{ chains: { chainId: number; name: string }[] }>(`query($r: ChainsRequest!) { chains(request: $r) { chainId name } }`, { r: { query: { filter: "MAINNET_ONLY" } } });
    const keyOf = (id: number) => (Object.values(CHAINS).find((c) => c.vm === "evm" && c.chainId === id)?.key as ChainKey | undefined) ?? null;
    chainCache = { at: Date.now(), chains: d.chains.map((c) => ({ chainId: c.chainId, name: c.name, key: keyOf(c.chainId) })) };
  }
  return chainCache.chains;
}

/** Chain ids for a filter: a chain key, a chain name, or all Aave v4 chains. */
async function chainIdsFor(chain?: string): Promise<number[]> {
  const all = await v4Chains();
  if (!chain) return all.map((c) => c.chainId);
  const want = chain.toLowerCase();
  const hit = all.filter((c) => c.key === want || c.name.toLowerCase().includes(want) || String(c.chainId) === want);
  if (hit.length === 0) throw new Error(`Aave v4 is not deployed on "${chain}". Aave v4 chains: ${all.map((c) => c.name).join(", ")}.`);
  return hit.map((c) => c.chainId);
}

export interface V4Reserve {
  /** Pass this id to the action functions. */
  id: string;
  chain: string; chainId: number;
  spoke: string; spokeAddress: string; hub: string; symbol: string; token: string; decimals: number;
  /** Percent values: 3.99 means 3.99%. */
  supplyApyPct: number; borrowApyPct: number; collateralFactorPct: number; suppliedUsd: number;
  canSupply: boolean; canBorrow: boolean; canUseAsCollateral: boolean;
}

/** Live Aave v4 reserves on every Aave v4 chain, or on one chain. A token can be in several spokes, with a different rate and risk in each one. */
export async function listReserves(filter: { asset?: string; spoke?: string; chain?: string } = {}): Promise<V4Reserve[]> {
  const chainIds = await chainIdsFor(filter.chain);
  const d = await gql<{ reserves: any[] }>(
    `query($r: ReservesRequest!) { reserves(request: $r) {
      id canSupply canBorrow canUseAsCollateral
      chain { chainId name }
      spoke { name address }
      asset { hub { name } underlying { address info { symbol decimals } } }
      summary { supplyApy { normalized } borrowApy { normalized } supplied { exchange(currency: USD) { value } } }
      settings { collateralFactor { normalized } }
    } }`,
    { r: { query: { chainIds }, filter: "ALL", orderBy: { supplyAvailable: "DESC" } } },
  );
  const rows = d.reserves.map((r): V4Reserve => ({
    id: r.id, chain: r.chain.name, chainId: r.chain.chainId, spoke: r.spoke.name, spokeAddress: r.spoke.address, hub: r.asset.hub.name,
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

export interface V4Position { chain: string; chainId: number; spoke: string; spokeAddress: string; suppliedUsd: number; collateralUsd: number; debtUsd: number; healthFactor: number | null; netApyPct: number; collateralFactorPct: number }

/** One position for each spoke the user is in, on every Aave v4 chain. The health factor is separate for each spoke. */
export async function getPositions(user: string): Promise<V4Position[]> {
  const chainIds = await chainIdsFor();
  const d = await gql<{ userPositions: any[] }>(
    `query($r: UserPositionsRequest!) { userPositions(request: $r) {
      spoke { name address chain { chainId name } }
      totalSupplied(currency: USD) { current { value } }
      totalCollateral(currency: USD) { current { value } }
      totalDebt(currency: USD) { current { value } }
      healthFactor { current }
      netApy { normalized }
      averageCollateralFactor { normalized }
    } }`,
    { r: { user, filter: { chainIds }, orderBy: { balance: "DESC" } } },
  );
  return d.userPositions.map((p) => ({
    chain: p.spoke.chain.name, chainId: p.spoke.chain.chainId, spoke: p.spoke.name, spokeAddress: p.spoke.address,
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
export async function buildAction(args: { action: V4Action; reserveId: string; amount: string; sender: string; native?: boolean; max?: boolean }): Promise<{ chainId: number; chain: V4Chain; transactions: EvmTx[] }> {
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
  const txs = ((): { tx: ApiTx; description: string }[] => {
    switch (plan.__typename) {
      case "TransactionRequest":
        return [{ tx: plan, description: label }];
      case "Erc20ApprovalRequired":
        return [...plan.approvals.map((a: { byTransaction: ApiTx }) => ({ tx: a.byTransaction, description: `Approve the token for Aave v4 (${plan.reason})` })), { tx: plan.originalTransaction, description: label }];
      case "PreContractActionRequired":
        return [{ tx: plan.transaction, description: `Aave v4 setup (${plan.reason})` }, { tx: plan.originalTransaction, description: label }];
      case "InsufficientBalanceError":
        throw new Error(`The wallet holds ${plan.available.value} and the action needs ${plan.required.value}.`);
      default:
        throw new Error(`Aave v4 API returned an unknown plan type: ${plan.__typename}`);
    }
  })();
  const chainId = txs[0]!.tx.chainId;
  const chain = (await v4Chains()).find((c) => c.chainId === chainId) ?? { chainId, name: `chain ${chainId}`, key: null };
  return { chainId, chain, transactions: txs.map((t) => toTx(t.tx, t.description)) };
}
