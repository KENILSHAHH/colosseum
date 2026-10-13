"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, RefreshCw, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { api, short, usd, type Positions } from "@/lib/api";

const n = (v: number | null | undefined, d = 2) => (v === null || v === undefined ? "—" : v.toLocaleString("en-US", { maximumFractionDigits: d }));

/** Local logos for the chains of this product. Other chains use the LI.FI logo. */
const CHAIN_LOGO: Record<number, string> = {
  1: "/icons/chain-ethereum.png", 8453: "/icons/chain-base.png", 42161: "/icons/chain-arbitrum.png", 4663: "/icons/chain-robinhood.svg",
  4217: "/icons/chain-tempo.svg", 999: "/icons/chain-hyperliquid.svg", 0: "/icons/chain-solana.svg",
};
const CHAIN_ID: Record<string, number> = { ethereum: 1, base: 8453, arbitrum: 42161 };

/** A token or venue logo with a small chain logo at its corner. A missing logo shows the first letter. */
function Logo({ src, label, chain }: { src: string | null; label: string; chain?: string | null }) {
  const [broken, setBroken] = useState(false);
  return (
    <span className="relative size-8 shrink-0">
      {src && !broken ? (
        <img src={src} alt="" onError={() => setBroken(true)} className="size-8 rounded-full bg-raised object-cover" />
      ) : (
        <span className="grid size-8 place-items-center rounded-full bg-raised text-[12px] font-bold text-dim">{label.slice(0, 1)}</span>
      )}
      {chain && <img src={chain} alt="" className="absolute -bottom-0.5 -right-0.5 size-3.5 rounded-full border border-panel bg-panel" />}
    </span>
  );
}

function Row({ logo, title, sub, value, valueSub, valueClass = "" }: { logo: React.ReactNode; title: React.ReactNode; sub?: React.ReactNode; value: React.ReactNode; valueSub?: React.ReactNode; valueClass?: string }) {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      {logo}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 truncate text-[13.5px] font-semibold">{title}</div>
        {sub && <div className="truncate text-[11.5px] text-faint">{sub}</div>}
      </div>
      <div className="shrink-0 text-right">
        <div className={`font-mono text-[13px] tabular-nums ${valueClass}`}>{value}</div>
        {valueSub && <div className="font-mono text-[11px] tabular-nums text-faint">{valueSub}</div>}
      </div>
    </div>
  );
}

function Card({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mb-5">
      <div className="mb-2 flex items-baseline justify-between px-1">
        <h2 className="text-[12px] font-medium uppercase tracking-wider text-faint">{title}</h2>
        {right && <span className="font-mono text-[12px] tabular-nums text-dim">{right}</span>}
      </div>
      <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel">{children}</div>
    </section>
  );
}

const Pill = ({ children, tone }: { children: React.ReactNode; tone: "good" | "bad" | "warn" | "dim" }) => (
  <span className={`rounded-md px-1.5 py-px text-[10.5px] font-semibold ${{ good: "bg-good/15 text-good", bad: "bg-bad/15 text-bad", warn: "bg-warn/15 text-warn", dim: "bg-raised text-dim" }[tone]}`}>{children}</span>
);

const hfTone = (hf: number | null) => (hf === null ? "dim" : hf < 1.25 ? "warn" : "good");

export function PositionsView() {
  const { data, isLoading, isFetching, refetch, error } = useQuery({ queryKey: ["positions"], queryFn: () => api<Positions>("/positions"), refetchInterval: 15_000 });

  if (isLoading) return <p className="p-8 text-sm text-faint">Reading your account from the chains…</p>;
  if (error || !data) return <p className="p-8 text-sm text-bad">{(error as Error)?.message ?? "Could not load the account."}</p>;

  const hl = data.hyperliquid;
  const v4 = data.aaveV4 ?? [];
  const assets = data.assets ?? [];
  const solTokens = (data.solana?.tokens ?? []).filter((t) => (t.usd ?? 0) >= 0.01);
  const walletUsd = assets.reduce((s, a) => s + (a.usd ?? 0), 0) + solTokens.reduce((s, t) => s + (t.usd ?? 0), 0);
  const hlUsd = hl.accounts.reduce((s, a) => s + a.accountValue, 0);
  const aaveNet = data.aave.reduce((s, a) => s + a.collateralUsd - a.debtUsd, 0) + v4.reduce((s, a) => s + a.suppliedUsd - a.debtUsd, 0);
  const total = walletUsd + hlUsd + aaveNet;
  const guarded = (venue: string, match: (p: Record<string, any>) => boolean) => data.guards.some((g) => g.venue === venue && match(g.params));
  const positionCount = hl.positions.length + data.aave.length + v4.length;

  return (
    <div className="mx-auto w-full max-w-[720px] px-4 py-7 sm:px-6">
      <div className="mb-6 flex items-end justify-between gap-3">
        <div>
          <p className="text-[12px] font-medium uppercase tracking-wider text-faint">Total value</p>
          <p className="mt-1 font-mono text-3xl font-bold tabular-nums tracking-tight">{usd(total)}</p>
          <div className="mt-2 flex flex-wrap gap-3 text-[12px] text-dim">
            <span className="flex items-center gap-1.5"><img src="/icons/eth.png" alt="" className="size-3.5 rounded-full" /> Wallet {usd(walletUsd)}</span>
            <span className="flex items-center gap-1.5"><img src="/icons/hyperliquid.webp" alt="" className="size-3.5 rounded-full" /> Hyperliquid {usd(hlUsd)}</span>
            {aaveNet !== 0 && <span className="flex items-center gap-1.5"><img src="/icons/aave.webp" alt="" className="size-3.5 rounded-full" /> Aave {usd(aaveNet)}</span>}
          </div>
        </div>
        <button onClick={() => refetch()} title="Refresh" aria-label="Refresh" className="grid size-9 place-items-center rounded-lg border border-line text-dim hover:text-ink">
          <RefreshCw className={`size-3.5 ${isFetching ? "animate-spin" : ""}`} />
        </button>
      </div>

      {(data.errors.length > 0 || data.assets === null) && (
        <div className="mb-4 flex gap-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-[12.5px] text-warn">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <div>Some sources did not answer, so this view can be incomplete. {[...data.errors, ...(data.assets === null ? ["wallet tokens"] : [])].join("; ")}</div>
        </div>
      )}

      <Card title="Positions" right={positionCount ? `${positionCount} open` : undefined}>
        {positionCount === 0 && <p className="px-4 py-3.5 text-[13px] text-faint">No open position. Ask the agent to open one.</p>}
        {hl.positions.map((p) => {
          const long = p.size > 0;
          const near = p.distanceToLiquidation !== null && p.distanceToLiquidation < 0.08;
          return (
            <Row
              key={`${p.dex}-${p.coin}`}
              logo={<Logo src="/icons/hyperliquid.webp" label="H" />}
              title={<>{p.coin} <Pill tone={long ? "good" : "bad"}>{long ? "Long" : "Short"} {p.leverage}x</Pill>{guarded("hyperliquid", (x) => x.coin === p.coin) && <ShieldCheck className="size-3.5 text-good" />}</>}
              sub={<>Entry {n(p.entryPx)} · Liq {n(p.liquidationPx)}{p.distanceToLiquidation !== null && <span className={near ? "text-warn" : ""}> ({(p.distanceToLiquidation * 100).toFixed(0)}% away)</span>}</>}
              value={`${p.unrealizedPnl >= 0 ? "+" : ""}${usd(p.unrealizedPnl)}`}
              valueClass={p.unrealizedPnl >= 0 ? "text-good" : "text-bad"}
              valueSub={usd(p.positionValue)}
            />
          );
        })}
        {data.aave.map((a) => (
          <Row
            key={`v3-${a.chain}`}
            logo={<Logo src="/icons/aave.webp" label="A" chain={CHAIN_LOGO[CHAIN_ID[a.chainKey] ?? -1] ?? null} />}
            title={<>Aave v3 <span className="font-normal text-faint">{a.chain}</span>{guarded("aave", (x) => x.chain === a.chainKey) && <ShieldCheck className="size-3.5 text-good" />}</>}
            sub={`Supplied ${usd(a.collateralUsd)} · Debt ${usd(a.debtUsd)}`}
            value={<Pill tone={hfTone(a.healthFactor)}>{a.healthFactor === null ? "No debt" : `HF ${n(a.healthFactor, 2)}`}</Pill>}
            valueSub={usd(a.collateralUsd - a.debtUsd)}
          />
        ))}
        {v4.map((a) => (
          <Row
            key={`v4-${a.chain}-${a.spoke}`}
            logo={<Logo src="/icons/aave.webp" label="A" chain={CHAIN_LOGO[CHAIN_ID[a.chain.toLowerCase()] ?? -1] ?? null} />}
            title={<>Aave v4 <span className="font-normal text-faint">{a.spoke}</span></>}
            sub={`Supplied ${usd(a.suppliedUsd)} · Debt ${usd(a.debtUsd)} · ${a.netApyPct.toFixed(2)}% APY`}
            value={<Pill tone={hfTone(a.healthFactor)}>{a.healthFactor === null ? "No debt" : `HF ${n(a.healthFactor, 2)}`}</Pill>}
            valueSub={usd(a.suppliedUsd - a.debtUsd)}
          />
        ))}
        {hl.accounts.filter((a) => a.accountValue >= 0.01).map((a) => (
          <Row
            key={`hl-${a.dex}`}
            logo={<Logo src="/icons/hyperliquid.webp" label="H" />}
            title={<>Hyperliquid <span className="font-normal text-faint">{a.dex === "core" ? "account" : a.dex}</span></>}
            sub={`Free ${usd(a.withdrawable)} · In use ${usd(a.marginUsed)}`}
            value={usd(a.accountValue)}
          />
        ))}
      </Card>

      <Card title="Wallet" right={usd(walletUsd)}>
        {assets.length === 0 && solTokens.length === 0 && (
          <p className="px-4 py-3.5 text-[13px] text-faint">No tokens yet. Send any token to <span className="select-all font-mono text-dim">{short(data.address)}</span> on any EVM chain.</p>
        )}
        {assets.map((a) => (
          <Row
            key={`${a.chainId}-${a.token}`}
            logo={<Logo src={a.logo} label={a.symbol} chain={CHAIN_LOGO[a.chainId] ?? a.chainLogo} />}
            title={a.symbol}
            sub={a.chainName}
            value={a.usd === null ? "—" : usd(a.usd)}
            valueSub={n(a.amount, a.amount < 1 ? 6 : 4)}
          />
        ))}
        {solTokens.map((t) => (
          <Row
            key={`sol-${t.mint}`}
            logo={<Logo src={t.symbol === "SOL" ? "/icons/chain-solana.svg" : t.logo} label={t.symbol} chain={t.symbol === "SOL" ? null : CHAIN_LOGO[0]} />}
            title={t.symbol}
            sub="Solana"
            value={t.usd === null ? "—" : usd(t.usd)}
            valueSub={n(t.amount, t.amount < 1 ? 6 : 4)}
          />
        ))}
      </Card>
    </div>
  );
}
