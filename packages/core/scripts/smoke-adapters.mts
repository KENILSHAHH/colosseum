const root = new URL("../src", import.meta.url).pathname;
const hl = await import(`${root}/adapters/hyperliquid.ts`);
const y = await import(`${root}/adapters/yields.ts`);
const jup = await import(`${root}/adapters/jupiter.ts`);
const relay = await import(`${root}/adapters/relay.ts`);
const aave = await import(`${root}/adapters/aave.ts`);
const t = async (name: string, f: () => Promise<unknown>) => {
  try { console.log(`\n== ${name}\n`, JSON.stringify(await f(), null, 1).slice(0, 1400)); }
  catch (e) { console.log(`\n== ${name} FAILED\n`, String(e).slice(0, 600)); }
};
await t("hl gold", async () => (await hl.findMarkets("gold")).map((m: any) => [m.coin, m.assetId, m.markPx, m.maxLeverage, m.marginMode, m.collateralToken, Math.round(m.dayVolumeUsd)]));
await t("hl preview", async () => { const p = await hl.previewOrder({ coin: "xyz:GOLD", isLong: true, marginUsd: 500, leverage: 5 }); return { ...p, market: p.market.coin }; });
await t("hl outcomes", () => hl.listOutcomes("NFL", 2));
await t("rates", async () => { const r = await y.compareLendingRates({ asset: "USDC" }); return { n: r.rows.length, failed: r.failedSources, top: r.rows.slice(0, 8).map((x: any) => [x.chain, x.protocol, x.market, x.supplyApy.toFixed(2), Math.round(x.tvlUsd ?? 0), x.sourceType]) }; });
await t("jup", async () => { const q = await jup.quoteSwap({ from: "SOL", to: "USDC", amount: 0.1 }); return q; });
await t("relay base->hl", async () => { const q = await relay.quoteBridge({ fromChain: "base", toChain: "hyperliquid", fromToken: "USDC", toToken: "USDC", amount: 1000 }); return { ...q, steps: q.steps.map((s: any) => [s.id, s.kind, s.description]) }; });
await t("relay base->tempo", async () => { const q = await relay.quoteBridge({ fromChain: "base", toChain: "tempo", fromToken: "USDC", toToken: "USDC", amount: 100 }); return { to: q.to, eta: q.etaSeconds, fee: q.totalFeeUsd }; });
await t("aave preview", async () => { const p = await aave.previewSupplyBorrow({ chain: "arbitrum", user: "0x000000000000000000000000000000000000dEaD", collateral: "ETH", collateralAmount: 2, borrow: "USDC", targetLtv: 0.6 }); return { ...p, transactions: p.transactions.map((x: any) => [x.to, x.description]) }; });
