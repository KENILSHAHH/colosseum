// Jupiter adapter (Solana). Docs: https://developers.jup.ag/docs
// The lite host needs no API key. Checked live on 2026-10-11.
import { getJson, postJson } from "./http";

const JUP = "https://lite-api.jup.ag";

export const SOLANA_MINTS: Record<string, { mint: string; decimals: number }> = {
  SOL: { mint: "So11111111111111111111111111111111111111112", decimals: 9 },
  USDC: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 },
};

interface TokenInfo { id: string; symbol: string; name: string; decimals: number; isVerified?: boolean; usdPrice?: number; mcap?: number }

/** Resolve a symbol or mint. Only verified tokens match a symbol. */
export async function resolveToken(symbolOrMint: string): Promise<{ mint: string; decimals: number; symbol: string }> {
  const known = SOLANA_MINTS[symbolOrMint.toUpperCase()];
  if (known) return { ...known, symbol: symbolOrMint.toUpperCase() };
  const results = await getJson<TokenInfo[]>(`${JUP}/tokens/v2/search?query=${encodeURIComponent(symbolOrMint)}`);
  const exactMint = results.find((t) => t.id === symbolOrMint);
  const pick = exactMint ?? results.filter((t) => t.isVerified && t.symbol.toUpperCase() === symbolOrMint.toUpperCase()).sort((a, b) => (b.mcap ?? 0) - (a.mcap ?? 0))[0];
  if (!pick) throw new Error(`No verified Solana token matches "${symbolOrMint}". Give the mint address.`);
  return { mint: pick.id, decimals: pick.decimals, symbol: pick.symbol };
}

export async function prices(mints: string[]) {
  return getJson<Record<string, { usdPrice: number; decimals: number }>>(`${JUP}/price/v3?ids=${mints.join(",")}`);
}

export interface UltraOrder {
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: { percent: number; swapInfo: { label: string } }[];
  transaction?: string | null;
  requestId?: string;
  errorMessage?: string;
}

/** Quote a swap. With `taker` the response also holds an unsigned transaction for that wallet. */
export async function quoteSwap(args: { from: string; to: string; amount: number; taker?: string }) {
  const [input, output] = await Promise.all([resolveToken(args.from), resolveToken(args.to)]);
  const raw = BigInt(Math.round(args.amount * 10 ** input.decimals));
  const url = `${JUP}/ultra/v1/order?inputMint=${input.mint}&outputMint=${output.mint}&amount=${raw}${args.taker ? `&taker=${args.taker}` : ""}`;
  const order = await getJson<UltraOrder>(url);
  return {
    input, output,
    inAmount: Number(order.inAmount) / 10 ** input.decimals,
    outAmount: Number(order.outAmount) / 10 ** output.decimals,
    minOutAmount: Number(order.otherAmountThreshold) / 10 ** output.decimals,
    priceImpactPct: Number(order.priceImpactPct) * 100,
    slippageBps: order.slippageBps,
    route: order.routePlan.map((r) => `${r.percent}% ${r.swapInfo.label}`),
    transaction: order.transaction ?? null,
    requestId: order.requestId ?? null,
    error: order.errorMessage ?? null,
  };
}

export function executeSwap(signedTransaction: string, requestId: string) {
  return postJson<{ status: string; signature?: string; error?: string }>(`${JUP}/ultra/v1/execute`, { signedTransaction, requestId });
}
