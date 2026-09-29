// Lending rate comparison across chains.
// Primary sources are the protocols' own APIs. DefiLlama fills the chains with no direct adapter yet.
import { createPublicClient, http, parseAbi } from "viem";
import { AaveV3Arbitrum, AaveV3Base, AaveV3Ethereum } from "@bgd-labs/aave-address-book";
import { CHAINS, type ChainKey } from "../registry/chains";
import { getJson } from "./http";

export interface RateRow {
  chain: string;
  protocol: string;
  market: string;
  asset: string;
  supplyApy: number;
  tvlUsd: number | null;
  source: string;
  sourceType: "onchain" | "protocol-api" | "aggregator";
}

const SECONDS_PER_YEAR = 31_536_000;
const RAY = 1e27;

// Addresses come from the official Aave address book package (bgd-labs/aave-address-book).
const AAVE: Partial<Record<ChainKey, typeof AaveV3Ethereum | typeof AaveV3Arbitrum | typeof AaveV3Base>> = {
  ethereum: AaveV3Ethereum,
  arbitrum: AaveV3Arbitrum,
  base: AaveV3Base,
};

const dataProviderAbi = parseAbi([
  "function getReserveData(address asset) view returns (uint256 unbacked, uint256 accruedToTreasuryScaled, uint256 totalAToken, uint256 totalStableDebt, uint256 totalVariableDebt, uint256 liquidityRate, uint256 variableBorrowRate, uint256 stableBorrowRate, uint256 averageStableBorrowRate, uint256 liquidityIndex, uint256 variableBorrowIndex, uint40 lastUpdateTimestamp)",
]);

async function aaveRates(symbol: string): Promise<RateRow[]> {
  const rows = await Promise.allSettled(
    (Object.keys(AAVE) as ChainKey[]).map(async (chain): Promise<RateRow | null> => {
      const book = AAVE[chain]!;
      const asset = (book.ASSETS as Record<string, { UNDERLYING: `0x${string}`; decimals: number }>)[symbol];
      if (!asset) return null;
      const client = createPublicClient({ transport: http(CHAINS[chain].rpc()) });
      const d = await client.readContract({
        address: book.AAVE_PROTOCOL_DATA_PROVIDER, abi: dataProviderAbi, functionName: "getReserveData", args: [asset.UNDERLYING],
      });
      const apr = Number(d[5]) / RAY;
      const apy = (1 + apr / SECONDS_PER_YEAR) ** SECONDS_PER_YEAR - 1;
      const tvl = Number(d[2]) / 10 ** asset.decimals;
      return {
        chain: CHAINS[chain].name, protocol: "Aave v3", market: "Core", asset: symbol, supplyApy: apy * 100,
        tvlUsd: tvl, source: `${CHAINS[chain].explorer}/address/${book.AAVE_PROTOCOL_DATA_PROVIDER}`, sourceType: "onchain",
      };
    }),
  );
  return rows.flatMap((r) => (r.status === "fulfilled" && r.value ? [r.value] : []));
}

interface JupLendToken { symbol: string; asset: { symbol: string }; totalRate?: string; supplyRate?: string; rewardsRate?: string; totalAssets?: string; asset_price?: string }

async function jupiterLendRates(symbol: string): Promise<RateRow[]> {
  // Docs: https://developers.jup.ag/docs/lend
  const tokens = await getJson<JupLendToken[]>("https://lite-api.jup.ag/lend/v1/earn/tokens");
  return tokens
    .filter((t) => t.asset.symbol.toUpperCase() === symbol)
    .map((t) => ({
      chain: "Solana", protocol: "Jupiter Lend", market: "Earn", asset: symbol,
      // Rates are in basis points (10000 = 100%).
      supplyApy: Number(t.totalRate ?? t.supplyRate ?? 0) / 100,
      tvlUsd: t.totalAssets ? Number(t.totalAssets) / 1e6 : null,
      source: "https://lite-api.jup.ag/lend/v1/earn/tokens", sourceType: "protocol-api",
    }));
}

interface LlamaPool { chain: string; project: string; symbol: string; apy: number | null; tvlUsd: number; pool: string; poolMeta: string | null }

const LLAMA_PROJECTS: Record<string, string> = {
  "kamino-lend": "Kamino",
  "morpho-blue": "Morpho",
  "morpho-v1": "Morpho",
  "spark": "Spark",
  "sparklend": "SparkLend",
  "moonwell-lending": "Moonwell",
  "hyperlend-pooled": "HyperLend",
  "save": "Save",
  "marginfi-lst": "MarginFi",
  "fluid-lending": "Fluid",
  "compound-v3": "Compound v3",
};

async function llamaRates(symbol: string, minTvlUsd: number): Promise<RateRow[]> {
  const chains = new Set(Object.values(CHAINS).flatMap((c) => (c.llamaName ? [c.llamaName] : [])));
  const { data } = await getJson<{ data: LlamaPool[] }>("https://yields.llama.fi/pools", { timeoutMs: 30_000 });
  return data
    .filter((p) => p.symbol.toUpperCase() === symbol && chains.has(p.chain) && p.project in LLAMA_PROJECTS && p.tvlUsd >= minTvlUsd && p.apy !== null)
    .map((p) => ({
      chain: p.chain === "Hyperliquid L1" ? "HyperEVM" : p.chain, protocol: LLAMA_PROJECTS[p.project]!, market: p.poolMeta ?? "", asset: symbol,
      supplyApy: p.apy ?? 0, tvlUsd: p.tvlUsd, source: `https://defillama.com/yields/pool/${p.pool}`, sourceType: "aggregator" as const,
    }));
}

export async function compareLendingRates(args: { asset: string; chains?: string[]; minTvlUsd?: number }) {
  const symbol = args.asset.toUpperCase();
  const minTvl = args.minTvlUsd ?? 1_000_000;
  const settled = await Promise.allSettled([aaveRates(symbol), jupiterLendRates(symbol), llamaRates(symbol, minTvl)]);
  const names = ["Aave on-chain", "Jupiter Lend API", "DefiLlama"];
  const failed = settled.flatMap((s, i) => (s.status === "rejected" ? [`${names[i]}: ${String(s.reason).slice(0, 120)}`] : []));
  let rows = settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
  if (args.chains?.length) {
    const want = new Set(args.chains.map((c) => c.toLowerCase()));
    rows = rows.filter((r) => [...want].some((w) => r.chain.toLowerCase().includes(w)));
  }
  rows = rows.filter((r) => r.tvlUsd === null || r.tvlUsd >= minTvl).sort((a, b) => b.supplyApy - a.supplyApy);
  return { asset: symbol, asOf: new Date().toISOString(), rows, failedSources: failed };
}
