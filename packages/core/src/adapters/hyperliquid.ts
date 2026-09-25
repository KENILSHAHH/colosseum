// Hyperliquid read adapter and order math.
// API reference: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals
// Asset ids:     https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/asset-ids
// Tick and lot:  https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/tick-and-lot-size
import { postJson } from "./http";

export const HL_API = "https://api.hyperliquid.xyz";
export const HL_WS = "wss://api.hyperliquid.xyz/ws";

const info = <T>(body: Record<string, unknown>) => postJson<T>(`${HL_API}/info`, body);

interface PerpDex { name: string; fullName: string; deployer: string }
interface UniverseEntry {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  onlyIsolated?: boolean;
  isDelisted?: boolean;
  marginMode?: string;
}
interface Meta { universe: UniverseEntry[]; collateralToken?: number }
interface AssetCtx { markPx: string; midPx: string | null; oraclePx: string; funding: string; openInterest: string; dayNtlVlm: string }

export interface HlMarket {
  coin: string;
  dex: string;
  dexFullName: string;
  assetId: number;
  szDecimals: number;
  maxLeverage: number;
  marginMode: string;
  collateralToken: number;
  markPx: number;
  oraclePx: number;
  fundingHourly: number;
  openInterestUsd: number;
  dayVolumeUsd: number;
}

/** Every live perp market on the core dex and on all HIP-3 dexes, with computed asset ids. */
let marketCache: { at: number; markets: HlMarket[] } | undefined;

export async function listPerpMarkets(): Promise<HlMarket[]> {
  if (marketCache && Date.now() - marketCache.at < 5_000) return marketCache.markets;
  const dexs = await info<(PerpDex | null)[]>({ type: "perpDexs" });
  // One request per dex. The array position of a dex in `perpDexs` is its perp_dex_index.
  const all = await Promise.all(dexs.map((d) => info<[Meta, AssetCtx[]]>({ type: "metaAndAssetCtxs", dex: d?.name ?? "" })));
  const out: HlMarket[] = [];
  all.forEach((entry, dexIndex) => {
    const [meta, ctxs] = entry;
    const dex = dexs[dexIndex];
    meta.universe.forEach((u, i) => {
      if (u.isDelisted) return;
      const ctx = ctxs?.[i];
      const mark = Number(ctx?.markPx ?? 0);
      out.push({
        coin: u.name,
        dex: dex?.name ?? "",
        dexFullName: dex?.fullName ?? "Hyperliquid core",
        // Core perps use the index. HIP-3 perps use 100000 + dexIndex * 10000 + index.
        assetId: dexIndex === 0 ? i : 100_000 + dexIndex * 10_000 + i,
        szDecimals: u.szDecimals,
        maxLeverage: u.maxLeverage,
        marginMode: u.marginMode ?? (u.onlyIsolated ? "isolated" : "cross"),
        collateralToken: meta.collateralToken ?? 0,
        markPx: mark,
        oraclePx: Number(ctx?.oraclePx ?? 0),
        fundingHourly: Number(ctx?.funding ?? 0),
        openInterestUsd: Number(ctx?.openInterest ?? 0) * mark,
        dayVolumeUsd: Number(ctx?.dayNtlVlm ?? 0),
      });
    });
  });
  marketCache = { at: Date.now(), markets: out };
  return out;
}

/** Markets whose name contains the query. "gold" also matches XAU and PAXG. */
export async function findMarkets(query: string): Promise<HlMarket[]> {
  const q = query.trim().toUpperCase();
  const aliases: Record<string, string[]> = {
    GOLD: ["GOLD", "XAU", "PAXG"],
    SILVER: ["SILVER", "XAG"],
  };
  const needles = aliases[q] ?? [q];
  const markets = await listPerpMarkets();
  return markets
    .filter((m) => {
      const base = (m.coin.split(":").pop() ?? m.coin).toUpperCase();
      return m.coin.toUpperCase() === q || needles.some((n) => base.includes(n));
    })
    .sort((a, b) => b.dayVolumeUsd - a.dayVolumeUsd);
}

export async function getMarket(coin: string): Promise<HlMarket> {
  const markets = await listPerpMarkets();
  const m = markets.find((x) => x.coin.toLowerCase() === coin.toLowerCase());
  if (!m) throw new Error(`Unknown Hyperliquid market "${coin}". Use hl_markets to list valid names.`);
  return m;
}

export interface HlPosition {
  coin: string;
  dex: string;
  size: number;
  entryPx: number;
  markPx: number;
  liquidationPx: number | null;
  /** Fraction of the mark price between mark and liquidation. null when there is no liquidation price. */
  distanceToLiquidation: number | null;
  leverage: number;
  leverageType: string;
  marginUsed: number;
  unrealizedPnl: number;
  positionValue: number;
}

interface ClearinghouseState {
  assetPositions: { position: {
    coin: string; szi: string; entryPx: string; positionValue: string; liquidationPx: string | null;
    marginUsed: string; unrealizedPnl: string; leverage: { type: string; value: number };
  } }[];
  marginSummary: { accountValue: string; totalMarginUsed: string; totalNtlPos: string };
  withdrawable: string;
}

export async function getAccount(user: string, dexes?: string[]) {
  const names = dexes ?? ["", ...(await info<(PerpDex | null)[]>({ type: "perpDexs" })).flatMap((d) => (d ? [d.name] : []))];
  const states = await Promise.all(
    names.map(async (dex) => ({ dex, state: await info<ClearinghouseState>({ type: "clearinghouseState", user, dex }) })),
  );
  const positions: HlPosition[] = [];
  const accounts = [];
  for (const { dex, state } of states) {
    const accountValue = Number(state.marginSummary.accountValue);
    if (accountValue === 0 && state.assetPositions.length === 0) continue;
    accounts.push({ dex: dex || "core", accountValue, marginUsed: Number(state.marginSummary.totalMarginUsed), withdrawable: Number(state.withdrawable) });
    for (const { position: p } of state.assetPositions) {
      const size = Number(p.szi);
      const positionValue = Number(p.positionValue);
      const markPx = size !== 0 ? positionValue / Math.abs(size) : 0;
      const liq = p.liquidationPx === null ? null : Number(p.liquidationPx);
      positions.push({
        coin: p.coin, dex: dex || "core", size, entryPx: Number(p.entryPx), markPx, liquidationPx: liq,
        distanceToLiquidation: liq === null || markPx === 0 ? null : Math.abs(markPx - liq) / markPx,
        leverage: p.leverage.value, leverageType: p.leverage.type, marginUsed: Number(p.marginUsed),
        unrealizedPnl: Number(p.unrealizedPnl), positionValue,
      });
    }
  }
  return { user, accounts, positions };
}

interface L2Book { levels: [{ px: string; sz: string }[], { px: string; sz: string }[]] }

/** Average fill price for a market order of `size`, from the live book. */
export async function estimateFill(coin: string, isBuy: boolean, size: number) {
  const book = await info<L2Book>({ type: "l2Book", coin });
  const levels = isBuy ? book.levels[1] : book.levels[0];
  let remaining = size;
  let cost = 0;
  for (const l of levels) {
    const take = Math.min(remaining, Number(l.sz));
    cost += take * Number(l.px);
    remaining -= take;
    if (remaining <= 0) break;
  }
  const filled = size - remaining;
  return { avgPx: filled > 0 ? cost / filled : 0, filledFraction: size > 0 ? filled / size : 0, bestPx: Number(levels[0]?.px ?? 0) };
}

/** Round a price to 5 significant figures and at most (6 - szDecimals) decimals. Perps only. */
export function roundPrice(px: number, szDecimals: number): string {
  const maxDecimals = Math.max(0, 6 - szDecimals);
  const sig = Number(px.toPrecision(5));
  return Number(sig.toFixed(maxDecimals)).toString();
}

export function roundSize(size: number, szDecimals: number): string {
  const f = 10 ** szDecimals;
  return (Math.floor(size * f) / f).toFixed(szDecimals);
}

/**
 * Estimated liquidation price for an isolated position.
 * Formula from https://hyperliquid.gitbook.io/hyperliquid-docs/trading/liquidations:
 *   liq = entry - side * marginAvailable / size / (1 - l * side), with l = 1 / (2 * maxLeverage).
 * Cross positions depend on the whole account. The real value comes from clearinghouseState after the fill.
 */
export function estimateLiquidationPx(args: { entryPx: number; leverage: number; maxLeverage: number; isLong: boolean }) {
  const side = args.isLong ? 1 : -1;
  const l = 1 / (2 * args.maxLeverage);
  const initialMarginPerUnit = args.entryPx / args.leverage;
  const maintenancePerUnit = args.entryPx * l;
  const marginAvailablePerUnit = initialMarginPerUnit - maintenancePerUnit;
  return args.entryPx - (side * marginAvailablePerUnit) / (1 - l * side);
}

export interface HlOrderPreview {
  market: HlMarket;
  isLong: boolean;
  marginUsd: number;
  leverage: number;
  notionalUsd: number;
  size: string;
  estEntryPx: number;
  limitPx: string;
  slippageBps: number;
  estLiquidationPx: number;
  distanceToLiquidation: number;
  estFeeUsd: number;
  builderFeeUsd: number;
  fundingHourly: number;
  warnings: string[];
}

/** Base taker fee tier. Source: https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees */
const TAKER_FEE = 0.00045;

export async function previewOrder(args: {
  coin: string; isLong: boolean; marginUsd: number; leverage: number; slippageBps?: number; builderFeeTenthBps?: number;
}): Promise<HlOrderPreview> {
  const market = await getMarket(args.coin);
  const warnings: string[] = [];
  if (args.leverage > market.maxLeverage) {
    throw new Error(`${market.coin} allows at most ${market.maxLeverage}x leverage. Requested ${args.leverage}x.`);
  }
  const slippageBps = args.slippageBps ?? 50;
  const notionalUsd = args.marginUsd * args.leverage;
  const rawSize = notionalUsd / market.markPx;
  const size = roundSize(rawSize, market.szDecimals);
  if (Number(size) <= 0) throw new Error(`Order size rounds to zero for ${market.coin}. Increase the margin.`);
  if (notionalUsd < 10) throw new Error("Hyperliquid needs an order value of 10 USD or more.");

  const fill = await estimateFill(market.coin, args.isLong, Number(size));
  const estEntryPx = fill.avgPx || market.markPx;
  if (fill.filledFraction < 1) warnings.push(`The visible book fills only ${(fill.filledFraction * 100).toFixed(0)}% of this size.`);
  const impactBps = Math.abs(estEntryPx - market.markPx) / market.markPx * 10_000;
  if (impactBps > slippageBps) warnings.push(`Estimated price impact is ${impactBps.toFixed(0)} bps. Your limit is ${slippageBps} bps.`);

  const limit = market.markPx * (1 + (args.isLong ? 1 : -1) * slippageBps / 10_000);
  const estLiquidationPx = estimateLiquidationPx({ entryPx: estEntryPx, leverage: args.leverage, maxLeverage: market.maxLeverage, isLong: args.isLong });
  if (market.dex) {
    warnings.push(`${market.coin} is a HIP-3 market from deployer "${market.dexFullName}". The deployer sets the oracle. Liquidity and open-interest caps differ from core markets.`);
  }
  if (market.collateralToken !== 0) warnings.push(`This dex does not use USDC as collateral (collateral token index ${market.collateralToken}). A swap is needed before the trade.`);
  if (market.marginMode !== "cross") warnings.push(`Margin mode is ${market.marginMode}. The position is isolated.`);

  const builderFee = (args.builderFeeTenthBps ?? 0) / 100_000;
  return {
    market, isLong: args.isLong, marginUsd: args.marginUsd, leverage: args.leverage, notionalUsd, size, estEntryPx,
    limitPx: roundPrice(limit, market.szDecimals), slippageBps, estLiquidationPx,
    distanceToLiquidation: Math.abs(estEntryPx - estLiquidationPx) / estEntryPx,
    estFeeUsd: notionalUsd * TAKER_FEE, builderFeeUsd: notionalUsd * builderFee, fundingHourly: market.fundingHourly, warnings,
  };
}

interface OutcomeMeta {
  outcomes: { outcome: number; name: string; description: string; sideSpecs: { name: string }[]; quoteToken?: string; venue?: string }[];
}

/** HIP-4 outcome markets. `description` holds pipe-separated key:value parameters. */
export async function listOutcomes(query?: string, limit = 25) {
  const meta = await info<OutcomeMeta>({ type: "outcomeMeta" });
  const q = query?.toLowerCase();
  return meta.outcomes
    .filter((o) => !q || o.description.toLowerCase().includes(q) || o.name.toLowerCase().includes(q))
    .slice(0, limit)
    .map((o) => ({
      outcomeId: o.outcome,
      template: o.name.replace(/^template:/, ""),
      params: Object.fromEntries(o.description.split("|").map((kv) => { const i = kv.indexOf(":"); return [kv.slice(0, i), kv.slice(i + 1)]; })),
      sides: o.sideSpecs.map((s) => s.name.replace(/^template:/, "")),
      quoteToken: o.quoteToken ?? "USDC",
      venue: o.venue,
    }));
}
