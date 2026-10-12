// Solana reads for the wallet of the user: balances (Jupiter) and transaction simulation (RPC).
import { config } from "../config";
import { getJson, postJson } from "./http";

const JUP = "https://lite-api.jup.ag";

/** Every token of the address with its UI amount. SOL is under the key "SOL". */
export async function balances(address: string) {
  const raw = await getJson<Record<string, { amount: string; uiAmount: number; slot: number; isFrozen: boolean }>>(`${JUP}/ultra/v1/balances/${address}`);
  const mints = Object.keys(raw).filter((k) => k !== "SOL" && raw[k]!.uiAmount > 0);
  const info = mints.length ? await getJson<{ id: string; symbol: string; usdPrice?: number }[]>(`${JUP}/tokens/v2/search?query=${mints.slice(0, 50).join(",")}`).catch(() => []) : [];
  const sol = await getJson<Record<string, { usdPrice: number }>>(`${JUP}/price/v3?ids=So11111111111111111111111111111111111111112`).catch(() => ({}) as Record<string, { usdPrice: number }>);
  return Object.entries(raw).filter(([, v]) => v.uiAmount > 0).map(([mint, v]) => {
    const meta = mint === "SOL" ? { symbol: "SOL", usdPrice: sol["So11111111111111111111111111111111111111112"]?.usdPrice } : info.find((t) => t.id === mint);
    return { mint, symbol: meta?.symbol ?? mint.slice(0, 6), amount: v.uiAmount, usd: meta?.usdPrice ? v.uiAmount * meta.usdPrice : null };
  });
}

/** Simulate a transaction (base64). The blockhash is replaced and signatures are not checked, so an unsigned transaction works. */
export async function simulate(transaction: string) {
  const r = await postJson<{ result?: { value: { err: unknown; logs: string[] | null; unitsConsumed?: number } }; error?: { message: string } }>(config().RPC_SOLANA, {
    jsonrpc: "2.0", id: 1, method: "simulateTransaction",
    params: [transaction, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "processed" }],
  });
  if (r.error) return { ok: false, error: r.error.message, logs: [] as string[] };
  const v = r.result!.value;
  return { ok: v.err === null, error: v.err === null ? null : JSON.stringify(v.err), logs: (v.logs ?? []).slice(-15), unitsConsumed: v.unitsConsumed ?? null };
}
