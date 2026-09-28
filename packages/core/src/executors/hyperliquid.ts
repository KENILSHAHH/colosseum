// Hyperliquid execution from the user's agent wallet.
// Signing rules: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/signing
import { ExchangeClient, HttpTransport } from "@nktkas/hyperliquid";
import * as hl from "../adapters/hyperliquid";
import { postJson } from "../adapters/http";
import { config } from "../config";
import { walletAccount } from "../wallet";

/**
 * The agent wallet is the Hyperliquid account. It signs orders with its own key.
 * Account data is read with the wallet address.
 */
async function agentClient(userId: string) {
  return new ExchangeClient({ transport: new HttpTransport(), wallet: await walletAccount(userId) });
}

function builder() {
  const c = config();
  return c.HL_BUILDER_ADDRESS ? { b: c.HL_BUILDER_ADDRESS.toLowerCase() as `0x${string}`, f: c.HL_BUILDER_FEE_TENTH_BPS } : undefined;
}

async function usdcTokenString() {
  const meta = await postJson<{ tokens: { name: string; tokenId: string }[] }>(`${hl.HL_API}/info`, { type: "spotMeta" });
  const usdc = meta.tokens.find((t) => t.name === "USDC");
  if (!usdc) throw new Error("USDC is missing from Hyperliquid spotMeta.");
  return `USDC:${usdc.tokenId}`;
}

type OrderStatus = { filled?: { totalSz: string; avgPx: string; oid: number }; resting?: { oid: number }; error?: string };

export interface OpenParams { coin: string; side: "long" | "short"; marginUsd: number; leverage: number; slippageBps?: number }

/**
 * Open a position: move collateral into the dex when needed, set leverage, send one IOC order, then read the result back.
 * The order is re-priced from live data. The confirmed preview bounds it: the entry may not be worse than the preview limit.
 */
export async function executeOpen(userId: string, address: string, p: OpenParams, previewLimitPx: string) {
  const client = await agentClient(userId);
  const fresh = await hl.previewOrder({ coin: p.coin, isLong: p.side === "long", marginUsd: p.marginUsd, leverage: p.leverage, slippageBps: p.slippageBps });
  const m = fresh.market;
  const isLong = p.side === "long";
  const bound = Number(previewLimitPx);
  if (isLong ? fresh.estEntryPx > bound : fresh.estEntryPx < bound) {
    throw new Error(`The price moved past the confirmed limit (${previewLimitPx}). Estimated entry is now ${fresh.estEntryPx}. No order was sent.`);
  }
  if (m.collateralToken !== 0) throw new Error(`Dex "${m.dex}" does not use USDC collateral. This path is not supported yet.`);

  // HIP-3 dexes hold their own collateral balance. Move the margin from the core perp account when the dex is short.
  if (m.dex) {
    const account = await hl.getAccount(address, [m.dex, ""]);
    const inDex = account.accounts.find((a) => a.dex === m.dex)?.withdrawable ?? 0;
    const need = p.marginUsd * 1.02 - inDex;
    if (need > 0) {
      const core = account.accounts.find((a) => a.dex === "core")?.withdrawable ?? 0;
      if (core < need) throw new Error(`Not enough free USDC. The trade needs ${need.toFixed(2)} more in dex "${m.dex}". The core perp account has ${core.toFixed(2)} free.`);
      await client.sendAsset({ destination: address as `0x${string}`, sourceDex: "", destinationDex: m.dex, token: await usdcTokenString() as `${string}:0x${string}`, amount: need.toFixed(2), fromSubAccount: "" });
    }
  }

  await client.updateLeverage({ asset: m.assetId, isCross: m.marginMode === "cross", leverage: p.leverage });
  const res = await client.order({
    orders: [{ a: m.assetId, b: isLong, p: previewLimitPx, s: fresh.size, r: false, t: { limit: { tif: "Ioc" } } }],
    grouping: "na",
    ...(builder() ? { builder: builder() } : {}),
  });
  const status = res.response.data.statuses[0] as OrderStatus;
  if (!status?.filled) throw new Error(`Order did not fill: ${status?.error ?? JSON.stringify(status)}`);

  // Verify from the clearinghouse, not from the order response.
  const after = await hl.getAccount(address, [m.dex]);
  const position = after.positions.find((x) => x.coin === m.coin) ?? null;
  return { coin: m.coin, orderId: status.filled.oid, filledSize: status.filled.totalSz, avgPx: status.filled.avgPx, position };
}

/**
 * Reduce a position with reduce-only IOC orders in chunks. The guard and the "close" intent both use it.
 * `fraction` 1 closes all. Each chunk is priced from the live mark with the slippage bound.
 */
export async function executeReduce(userId: string, address: string, args: { coin: string; fraction: number; maxSlippageBps: number; chunks?: number }) {
  const client = await agentClient(userId);
  const m = await hl.getMarket(args.coin);
  const start = (await hl.getAccount(address, [m.dex])).positions.find((x) => x.coin === m.coin);
  if (!start || start.size === 0) return { coin: m.coin, closedSize: 0, remainingSize: 0, fills: [] as { sz: string; px: string }[] };

  const target = Math.abs(start.size) * Math.min(1, args.fraction);
  const chunks = Math.max(1, args.chunks ?? (target * start.markPx > 50_000 ? 4 : 1));
  const isLong = start.size > 0;
  const fills: { sz: string; px: string }[] = [];
  let closed = 0;

  for (let i = 0; i < chunks * 2 && closed < target * 0.999; i++) {
    const live = await hl.getMarket(m.coin);
    const remaining = target - closed;
    const chunk = i >= chunks - 1 ? remaining : Math.min(remaining, target / chunks);
    // The last chunk of a full close uses the exact remaining size. Rounding down would leave dust.
    const size = args.fraction >= 1 && chunk === remaining ? Math.abs((await hl.getAccount(address, [m.dex])).positions.find((x) => x.coin === m.coin)?.size ?? 0).toFixed(m.szDecimals) : hl.roundSize(chunk, m.szDecimals);
    if (Number(size) <= 0) break;
    const px = hl.roundPrice(live.markPx * (1 + (isLong ? -1 : 1) * args.maxSlippageBps / 10_000), m.szDecimals);
    const res = await client.order({ orders: [{ a: m.assetId, b: !isLong, p: px, s: size, r: true, t: { limit: { tif: "Ioc" } } }], grouping: "na" });
    const st = res.response.data.statuses[0] as OrderStatus;
    if (st?.filled) {
      closed += Number(st.filled.totalSz);
      fills.push({ sz: st.filled.totalSz, px: st.filled.avgPx });
    }
  }
  const end = (await hl.getAccount(address, [m.dex])).positions.find((x) => x.coin === m.coin);
  return { coin: m.coin, closedSize: closed, remainingSize: end?.size ?? 0, fills };
}

/** Add isolated margin. `usd` has 6 decimals in the API. */
export async function executeAddMargin(userId: string, args: { coin: string; usd: number }) {
  const client = await agentClient(userId);
  const m = await hl.getMarket(args.coin);
  await client.updateIsolatedMargin({ asset: m.assetId, isBuy: true, ntli: Math.round(args.usd * 1e6) });
  return { coin: m.coin, addedUsd: args.usd };
}
