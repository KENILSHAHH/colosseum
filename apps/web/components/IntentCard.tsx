"use client";

import { AlertTriangle, Check, ExternalLink, Loader2, ShieldCheck, X } from "lucide-react";
import { useState } from "react";
import { post, usd, type Intent } from "@/lib/api";

const TITLES: Record<string, string> = {
  hl_open_position: "Open position",
  hl_close_position: "Close position",
  aave_supply_borrow: "Supply and borrow",
  guard_create: "Liquidation Guard",
  job_create: "Scheduled job",
  hl_tpsl: "Stop-loss / take-profit",
  hl_cancel_order: "Cancel order",
  hl_spot_order: "Hyperliquid spot order",
  hl_action: "Hyperliquid action",
  hl_deposit: "Deposit to Hyperliquid",
  bridge: "Bridge",
  evm_transactions: "Sign transactions",
};

const num = (v: unknown, d = 2) => (typeof v === "number" ? v.toLocaleString("en-US", { maximumFractionDigits: d }) : String(v ?? "—"));

/** Label and value rows for each kind of preview. Every number comes from the server preview. */
function rows(intent: Intent): [string, string][] {
  const p = intent.preview;
  switch (intent.kind) {
    case "hl_open_position":
      return [
        ["Market", `${p.market} · ${p.deployer}`],
        ["Side", `${String(p.side).toUpperCase()} ${p.leverage}x`],
        ["Margin", usd(p.marginUsd)],
        ["Size", `${p.size} (${usd(p.notionalUsd)})`],
        ["Est. entry", num(p.estEntryPx)],
        ["Worst price", String(p.limitPx)],
        ["Est. liquidation", `${num(p.estLiquidationPx)} (${num(p.distanceToLiquidationPct, 1)}% away)`],
        ["Exchange fee", usd(p.estFeeUsd + (p.builderFeeUsd ?? 0))],
        ["Stop loss", "None"],
      ];
    case "hl_close_position":
      return [["Market", p.market], ["Close size", num(p.closeSize, 4)], ["Mark", num(p.markPx)], ["Unrealized PnL", usd(p.unrealizedPnl)], ["Order", p.orderType]];
    case "aave_supply_borrow":
      return [
        ["Chain", p.chain],
        ["Supply", `${p.collateral.amount} ${p.collateral.symbol} (${usd(p.collateral.valueUsd)})`],
        ["Borrow", `${num(p.borrow.amount)} ${p.borrow.symbol}`],
        ["LTV", `${num(p.targetLtv * 100, 0)}% (max ${num(p.maxLtv * 100, 0)}%)`],
        ["Health factor after", num(p.healthFactorAfter)],
        ["Liquidation price", `${usd(p.collateralLiquidationPriceUsd)} per ${p.collateral.symbol}`],
      ];
    case "sol_swap":
      return [["Pay", p.from], ["Receive", p.to], ["Minimum received", num(p.minReceived, 6)], ["Price impact", `${num(p.priceImpactPct, 3)}%`], ["Route", (p.route ?? []).join(", ")]];
    case "bridge":
      return [
        ["From", `${p.from.amount} ${p.from.token} on ${p.from.chain}`],
        ["To", `${num(p.to.amount, 4)} ${p.to.token} on ${p.to.chain}`],
        ["Fee", usd(p.totalFeeUsd)],
        ["ETA", p.etaSeconds ? `${p.etaSeconds} s` : "—"],
        ["Route", p.provider],
      ];
    case "guard_create":
      return [["Chain", p.chain], ["Unwind", p.summary], ["Health factor now", num(p.healthFactorNow)], ["Acts below", num(p.healthFactorThreshold)], ["Unwind contract", p.unwindContract], ["Fork test", p.forkTest]];
    case "evm_transactions":
      return [["Chain", p.chain], ["What it does", p.summary], ["Simulation", p.simulation?.method ?? "—"]];
    default:
      return Object.entries(p).filter(([, v]) => typeof v !== "object").map(([k, v]) => [k, String(v)]);
  }
}

export function IntentCard({ intent: initial }: { intent: Intent }) {
  const [local, setLocal] = useState<Intent | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The stream can deliver a newer state of the same intent. The newest state wins.
  const intent = local && local.status !== "pending" ? local : initial.status !== "pending" ? initial : (local ?? initial);

  const p = intent.preview;
  const guard = p.guard as Record<string, any> | null | undefined;
  const warnings: string[] = p.warnings ?? [];
  const txs: { chainId: number; to: string | null; data: string; value: string; description: string }[] = p.transactions ?? [];
  const step = "The agent wallet signs and sends. This can take a minute.";

  async function decide(action: "confirm" | "reject") {
    setError(null);
    setBusy(true);
    try {
      setLocal(await post<Intent>(`/intents/${intent.id}/${action}`));
    } catch (e) {
      setError(e instanceof Error ? e.message.split("\n")[0]! : "The action failed");
    } finally {
      setBusy(false);
    }
  }
  const confirm = () => decide("confirm");
  const reject = () => decide("reject");

  const result = intent.result;

  return (
    <div className="my-3 overflow-hidden rounded-xl border border-line bg-panel">
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-accent">{p.venue ?? "Action"}</span>
          {TITLES[intent.kind] ?? intent.kind}
        </div>
        <StatusPill status={intent.status} />
      </div>

      <dl className="grid grid-cols-[minmax(110px,auto)_1fr] gap-x-6 gap-y-1.5 px-4 py-3 text-[13.5px]">
        {rows(intent).map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-dim">{k}</dt>
            <dd className="font-mono text-[13px] tabular-nums break-words">{v}</dd>
          </div>
        ))}
      </dl>

      {txs.length > 0 && (
        <ol className="mx-4 mb-3 space-y-1 rounded-lg border border-line bg-raised px-3 py-2 text-[13px]">
          {txs.map((t, i) => (
            <li key={i} className="flex gap-2">
              <span className="text-faint">{i + 1}.</span>
              <span className="flex-1">{t.description}</span>
              <span className="font-mono text-[11.5px] text-faint">{t.to ? `${t.to.slice(0, 8)}…` : "new contract"}</span>
            </li>
          ))}
        </ol>
      )}

      {guard && (
        <div className="mx-4 mb-3 flex gap-2.5 rounded-lg border border-line bg-raised px-3 py-2.5 text-[13px]">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-good" />
          <div>
            <div className="font-medium">
              Liquidation Guard:{" "}
              {guard.triggerPx
                ? `act at ${num(guard.triggerPx)} (${guard.triggerDistancePct}% before liquidation), ${String(guard.action).replaceAll("_", " ")}`
                : `act below health factor ${guard.healthFactorThreshold}, ${String(guard.action).replaceAll("_", " ")}`}
            </div>
            <div className="mt-0.5 text-dim">
              {usd(guard.pricePerMinuteUsd, 3)} per watched minute. {guard.disclosure}
            </div>
          </div>
        </div>
      )}

      {warnings.map((w) => (
        <div key={w} className="mx-4 mb-2 flex gap-2 text-[13px] text-warn">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>{w}</span>
        </div>
      ))}

      {Array.isArray(p.sources) && (
        <div className="mx-4 mb-3 text-[12px] text-faint">
          Sources:{" "}
          {p.sources.map((s: string, i: number) => (
            <span key={s}>
              {i > 0 && ", "}
              {s.startsWith("http") ? <a className="underline" href={s} target="_blank" rel="noreferrer">{new URL(s).hostname}</a> : s}
            </span>
          ))}
        </div>
      )}

      {intent.status === "pending" && (
        <div className="flex items-center justify-between gap-3 border-t border-line bg-raised px-4 py-2.5">
          <div className="text-[12.5px] text-dim">
            {busy ? step : <>Action fee {usd(intent.feeUsd)} · the agent wallet signs</>}
          </div>
          <div className="flex gap-2">
            <button onClick={reject} disabled={busy} className="rounded-lg border border-line px-3 py-1.5 text-sm text-dim hover:text-ink disabled:opacity-40">
              Reject
            </button>
            <button onClick={confirm} disabled={busy} className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-1.5 text-sm font-medium text-black hover:brightness-110 disabled:opacity-60">
              {busy && <Loader2 className="size-3.5 animate-spin" />}
              Confirm
            </button>
          </div>
        </div>
      )}


      {result && intent.status === "done" && (
        <div className="border-t border-line bg-raised px-4 py-2.5 text-[13px]">
          {result.avgPx && <div>Filled {result.filledSize} at {result.avgPx}. {result.position?.liquidationPx ? `Liquidation price ${num(result.position.liquidationPx)}.` : ""} {result.guardId ? "Guard is active." : ""}</div>}
          {result.closedSize !== undefined && <div>Closed {num(result.closedSize, 4)}. Remaining {num(result.remainingSize, 4)}.</div>}
          {result.orderId && <a href={result.explorer} target="_blank" rel="noreferrer" className="flex items-center gap-1 font-mono text-[12px] text-accent">Order {result.orderId} <ExternalLink className="size-3" /></a>}
          {result.account && <div>Health factor {num(result.account.healthFactor)}. Collateral {usd(result.account.collateralUsd)}. Debt {usd(result.account.debtUsd)}.</div>}
          {result.guardId && !result.avgPx && <div>Guard is active. Id {String(result.guardId).slice(0, 8)}.</div>}
          {(result.receipts ?? []).map((r: any) => (
            <a key={r.hash} href={r.explorer} target="_blank" rel="noreferrer" className="flex items-center gap-1 font-mono text-[12px] text-accent">
              {r.description}: {r.hash.slice(0, 14)}… <ExternalLink className="size-3" />
              {r.contractAddress && <span className="text-dim">→ contract {r.contractAddress}</span>}
            </a>
          ))}
          {result.signature && <a href={result.explorer} target="_blank" rel="noreferrer" className="font-mono text-[12px] text-accent">{String(result.signature).slice(0, 18)}…</a>}
        </div>
      )}
      {(error || (intent.status === "failed" && result?.error)) && (
        <div className="border-t border-line bg-raised px-4 py-2.5 text-[13px] text-bad">{error ?? result?.error}</div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: Intent["status"] }) {
  const map: Record<string, [string, string, React.ReactNode]> = {
    pending: ["Needs your confirmation", "text-warn", null],
    confirmed: ["Waiting for signature", "text-warn", <Loader2 key="i" className="size-3 animate-spin" />],
    executing: ["Executing", "text-warn", <Loader2 key="i" className="size-3 animate-spin" />],
    done: ["Done", "text-good", <Check key="i" className="size-3" />],
    failed: ["Failed", "text-bad", <X key="i" className="size-3" />],
    rejected: ["Rejected", "text-faint", <X key="i" className="size-3" />],
    expired: ["Expired", "text-faint", null],
  };
  const [label, color, icon] = map[status] ?? [status, "text-dim", null];
  return <span className={`flex items-center gap-1 text-[12px] ${color}`}>{icon}{label}</span>;
}
