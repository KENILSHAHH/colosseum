"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, RefreshCw, ShieldCheck } from "lucide-react";
import { api, usd, type Positions } from "@/lib/api";

const n = (v: number | null | undefined, d = 2) => (v === null || v === undefined ? "—" : v.toLocaleString("en-US", { maximumFractionDigits: d }));

export function PositionsView() {
  const { data, isLoading, isFetching, refetch, error } = useQuery({ queryKey: ["positions"], queryFn: () => api<Positions>("/positions"), refetchInterval: 10_000 });

  if (isLoading) return <p className="p-8 text-sm text-faint">Reading positions from the chains…</p>;
  if (error || !data) return <p className="p-8 text-sm text-bad">{(error as Error)?.message ?? "Could not load positions."}</p>;

  const hl = data.hyperliquid;
  const walletUsd = data.balances.reduce((s, b) => s + (b.usdc ?? 0), 0);
  const hlUsd = hl.accounts.reduce((s, a) => s + a.accountValue, 0);
  const v4 = data.aaveV4 ?? [];
  const aaveNet = data.aave.reduce((s, a) => s + a.collateralUsd - a.debtUsd, 0) + v4.reduce((s, a) => s + a.suppliedUsd - a.debtUsd, 0);
  const guardFor = (venue: string, match: (p: Record<string, any>) => boolean) => data.guards.find((g) => g.venue === venue && match(g.params));

  const nothing =
    data.errors.length === 0 && hl.positions.length === 0 && data.aave.length === 0 && v4.length === 0 && hlUsd === 0 && data.balances.every((b) => !b.error && (b.usdc ?? 0) === 0 && (b.eth ?? 0) === 0);
  if (nothing)
    return (
      <div className="mx-auto w-full max-w-[560px] px-6 py-20 text-center">
        <h1 className="text-xl font-semibold tracking-tight">You do not have any assets yet</h1>
        <p className="mt-2 text-[14px] leading-relaxed text-dim">Top up your agent wallet to start. Send any token on an EVM chain to this address. Your positions show here after that.</p>
        <div className="mt-5 select-all break-all rounded-xl border border-line bg-panel px-4 py-3 font-mono text-[13px]">{data.address}</div>
      </div>
    );

  return (
    <div className="mx-auto w-full max-w-[980px] px-6 py-7">
      <div className="mb-5 flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Positions</h1>
          <p className="mt-1 text-[13px] text-dim">Everything the agent wallet holds, read from the chains. Updated {new Date(data.asOf).toLocaleTimeString()}.</p>
        </div>
        <button onClick={() => refetch()} className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[13px] text-dim hover:text-ink">
          <RefreshCw className={`size-3.5 ${isFetching ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>

      {data.errors.length > 0 && (
        <div className="mb-4 flex gap-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-[13px] text-warn">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <div>Some sources did not answer. The view can be incomplete: {data.errors.join("; ")}</div>
        </div>
      )}

      <div className="mb-6 grid grid-cols-3 gap-3">
        <Stat label="Wallet USDC" value={usd(walletUsd)} />
        <Stat label="Hyperliquid account value" value={usd(hlUsd)} />
        <Stat label="Aave net value" value={usd(aaveNet)} />
      </div>

      <Block title="Hyperliquid perps" empty={hl.positions.length === 0 ? "No open perp position." : null}>
        <Table head={["Market", "Side", "Size", "Value", "Entry", "Mark", "Liq. price", "To liq.", "PnL", "Guard"]}>
          {hl.positions.map((p) => {
            const g = guardFor("hyperliquid", (x) => x.coin === p.coin);
            const near = p.distanceToLiquidation !== null && p.distanceToLiquidation < 0.08;
            return (
              <tr key={p.coin}>
                <td className="font-medium">{p.coin}</td>
                <td className={p.size > 0 ? "text-good" : "text-bad"}>{p.size > 0 ? "Long" : "Short"} {p.leverage}x</td>
                <td>{n(Math.abs(p.size), 5)}</td>
                <td>{usd(p.positionValue)}</td>
                <td>{n(p.entryPx)}</td>
                <td>{n(p.markPx)}</td>
                <td>{n(p.liquidationPx)}</td>
                <td className={near ? "text-warn" : ""}>{p.distanceToLiquidation === null ? "—" : `${(p.distanceToLiquidation * 100).toFixed(1)}%`}</td>
                <td className={p.unrealizedPnl >= 0 ? "text-good" : "text-bad"}>{usd(p.unrealizedPnl)}</td>
                <td>{g ? <GuardTag text={`acts at ${g.params.triggerDistancePct}%`} /> : <span className="text-faint">None</span>}</td>
              </tr>
            );
          })}
        </Table>
      </Block>

      <Block title="Aave v3" empty={data.aave.length === 0 ? "No Aave position." : null}>
        <Table head={["Chain", "Collateral", "Debt", "LTV now", "Liq. threshold", "Health factor", "Guard"]}>
          {data.aave.map((a) => {
            const g = guardFor("aave", (x) => x.chain === a.chainKey);
            const hf = a.healthFactor;
            return (
              <tr key={a.chain}>
                <td className="font-medium">{a.chain}</td>
                <td>{usd(a.collateralUsd)}</td>
                <td>{usd(a.debtUsd)}</td>
                <td>{a.collateralUsd > 0 ? `${((a.debtUsd / a.collateralUsd) * 100).toFixed(1)}%` : "—"}</td>
                <td>{(a.liquidationThreshold * 100).toFixed(0)}%</td>
                <td className={hf !== null && hf < 1.25 ? "text-warn" : hf !== null ? "text-good" : ""}>{hf === null ? "No debt" : n(hf, 3)}</td>
                <td>{g ? <GuardTag text={`acts below ${g.params.healthFactorThreshold}`} /> : <span className="text-faint">None</span>}</td>
              </tr>
            );
          })}
        </Table>
      </Block>

      {v4.length > 0 && (
        <Block title="Aave v4" empty={null}>
          <Table head={["Spoke", "Supplied", "Debt", "LTV now", "Health factor", "Net APY"]}>
            {v4.map((a) => (
              <tr key={a.spoke}>
                <td className="font-medium">{a.spoke}</td>
                <td>{usd(a.suppliedUsd)}</td>
                <td>{usd(a.debtUsd)}</td>
                <td>{a.collateralUsd > 0 ? `${((a.debtUsd / a.collateralUsd) * 100).toFixed(1)}%` : "—"}</td>
                <td className={a.healthFactor !== null && a.healthFactor < 1.25 ? "text-warn" : a.healthFactor !== null ? "text-good" : ""}>{a.healthFactor === null ? "No debt" : n(a.healthFactor, 3)}</td>
                <td>{a.netApyPct.toFixed(2)}%</td>
              </tr>
            ))}
          </Table>
        </Block>
      )}

      <Block title="Hyperliquid balances" empty={hl.accounts.length === 0 ? "No Hyperliquid balance." : null}>
        <Table head={["Dex", "Account value", "Margin used", "Free"]}>
          {hl.accounts.map((a) => (
            <tr key={a.dex}>
              <td className="font-medium">{a.dex}</td>
              <td>{usd(a.accountValue)}</td>
              <td>{usd(a.marginUsed)}</td>
              <td>{usd(a.withdrawable)}</td>
            </tr>
          ))}
        </Table>
      </Block>

      <Block title="Wallet balances" empty={null}>
        <Table head={["Chain", "USDC", "ETH (gas)"]}>
          {data.balances.map((b) => (
            <tr key={b.chain}>
              <td className="font-medium">{b.chainName}</td>
              <td>{b.error ? <span className="text-warn">not read</span> : n(b.usdc)}</td>
              <td>{b.error ? <span className="text-warn">not read</span> : n(b.eth, 5)}</td>
            </tr>
          ))}
        </Table>
      </Block>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-line bg-panel px-4 py-3">
      <div className="text-[12px] text-dim">{label}</div>
      <div className="mt-1 font-mono text-lg tabular-nums">{value}</div>
    </div>
  );
}

function Block({ title, empty, children }: { title: string; empty: string | null; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h2 className="mb-2 text-[12px] font-medium uppercase tracking-wider text-faint">{title}</h2>
      {empty ? <div className="rounded-xl border border-line bg-panel px-4 py-4 text-[13px] text-faint">{empty}</div> : children}
    </section>
  );
}

function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-panel">
      <table className="w-full text-[13px] tabular-nums [&_td]:whitespace-nowrap [&_td]:border-t [&_td]:border-line [&_td]:px-4 [&_td]:py-2.5 [&_td:not(:first-child)]:font-mono [&_td:not(:first-child)]:text-[12.5px]">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} className="whitespace-nowrap px-4 py-2 text-left text-[12px] font-medium text-dim">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function GuardTag({ text }: { text: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-good">
      <ShieldCheck className="size-3.5" /> {text}
    </span>
  );
}
