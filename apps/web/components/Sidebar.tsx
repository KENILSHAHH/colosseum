"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, LogOut, Plus, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { api, short, usd, type Me, type Permission } from "@/lib/api";
import { useLinkedWallet } from "@/lib/linkedWallet";
import type { useSession } from "@/lib/session";

interface Guard { id: string; venue: string; params: Record<string, any>; status: string; lastValue: number | null; lastCheck: string | null }

export function Sidebar({ session, onNewChat }: { session: ReturnType<typeof useSession>; onNewChat: () => void }) {
  const { me, signedIn } = session;

  return (
    <aside className="flex h-full w-[272px] shrink-0 flex-col border-r border-line bg-panel/60 backdrop-blur-xl">
      <div className="flex items-center gap-2 px-4 pt-4 pb-3">
        <div className="grid size-7 place-items-center rounded-lg bg-accent text-sm font-semibold text-black">◆</div>
        <div className="text-[15px] font-semibold tracking-tight">DeFi Agent</div>
      </div>

      <button onClick={onNewChat} className="mx-3 mb-3 flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm text-dim hover:bg-raised hover:text-ink">
        <Plus className="size-4" /> New chat
      </button>

      <div className="flex-1 space-y-5 overflow-y-auto px-3 pb-4">
        {!session.authenticated && (
          <Section title="Account">
            <button disabled={!session.ready} onClick={session.signIn} className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-black hover:brightness-110 disabled:opacity-60">
              Sign in or sign up
            </button>
          </Section>
        )}

        {session.authenticated && !signedIn && (
          <Section title="Account">
            {session.error ? (
              <>
                <p className="text-[12px] text-bad">{session.error}</p>
                <button onClick={session.signIn} className="mt-2 flex w-full items-center justify-center rounded-lg bg-accent px-3 py-2 text-sm font-medium text-black hover:brightness-110">
                  Try again
                </button>
              </>
            ) : (
              <div className="flex items-center gap-2 text-[12.5px] text-dim">
                <Loader2 className="size-3.5 animate-spin" /> Preparing your wallet
              </div>
            )}
            <button onClick={session.signOut} className="mt-2 text-[12px] text-faint hover:text-ink">
              Sign out
            </button>
          </Section>
        )}

        {signedIn && me && (
          <>
            <Section title="Signed in as">
              <div className="flex items-center justify-between">
                <span className="min-w-0">
                  {session.label && <span className="block truncate text-[12.5px]">{session.label}</span>}
                  <span className="block font-mono text-[12.5px] text-dim" title={`Your wallet: ${me.address}`}>{short(me.address)}</span>
                </span>
                <button onClick={session.signOut} title="Sign out" className="text-faint hover:text-ink">
                  <LogOut className="size-3.5" />
                </button>
              </div>
            </Section>
            <Balances />
            <LinkedWallet me={me} />
            <Guards />
          </>
        )}
      </div>

    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-1.5 px-1 text-[11px] font-medium uppercase tracking-wider text-faint">{title}</h3>
      <div className="rounded-lg border border-line bg-bg/40 p-3">{children}</div>
    </section>
  );
}

interface Balance { address: string; usd: number | null }

/** Two balances in USD: the agent wallet and the user's own wallet. A click copies the address. */
function Balances() {
  const { data } = useQuery({ queryKey: ["balances"], queryFn: () => api<{ agent: Balance; wallet: Balance }>("/billing/balances"), refetchInterval: 30_000 });
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (address: string) => {
    await navigator.clipboard.writeText(address);
    setCopied(address);
    setTimeout(() => setCopied(null), 1500);
  };
  const row = (label: string, b: Balance | undefined) => (
    <button disabled={!b} onClick={() => b && copy(b.address)} title={b ? `Copy ${b.address}` : undefined} className="flex w-full items-center justify-between rounded-md px-1 py-1 text-[13px] hover:bg-raised">
      <span className="flex items-center gap-1.5 text-dim">
        {label}
        {b && copied === b.address ? <Check className="size-3 text-good" /> : b && <span className="font-mono text-[11px] text-faint">{short(b.address)}</span>}
      </span>
      <span className="font-mono tabular-nums">{!b ? "…" : b.usd === null ? "not read" : usd(b.usd)}</span>
    </button>
  );
  return (
    <Section title="Balances">
      {row("Agent", data?.agent)}
      {row("Wallet", data?.wallet)}
    </Section>
  );
}

/** The user's own wallet. The agent acts from it only inside a permission that the user signed. */
function LinkedWallet({ me }: { me: Me }) {
  const wallet = useLinkedWallet();
  const { data } = useQuery({ queryKey: ["permissions"], queryFn: () => api<Permission[]>("/permissions"), refetchInterval: 10_000, enabled: !!me.linkedWallet });
  const [step, setStep] = useState<string | null>(null);

  if (!me.linkedWallet)
    return (
      <Section title="Your wallet">
        <button disabled={wallet.busy !== null} onClick={wallet.link} className="flex w-full items-center justify-center gap-2 rounded-lg border border-line px-3 py-2 text-[13px] text-dim hover:bg-raised hover:text-ink disabled:opacity-60">
          {wallet.busy === "link" && <Loader2 className="size-3.5 animate-spin" />} Link existing wallet
        </button>
        {wallet.error && <p className="mt-2 text-[11.5px] text-bad">{wallet.error}</p>}
      </Section>
    );

  return (
    <Section title="Your wallet">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[12.5px]" title={me.linkedWallet}>{short(me.linkedWallet)}</span>
        <button onClick={wallet.unlink} className="text-[11.5px] text-faint hover:text-bad" title="Unlink the wallet and remove its permissions">
          Unlink
        </button>
      </div>
      {(data ?? []).map((p) => (
        <div key={p.id} className="mt-2 border-t border-line pt-2 text-[12px]" title={`${p.reason}\n\n${p.functions.join("\n")}`}>
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate">
              {p.functions.length} {p.functions.length === 1 ? "function" : "functions"} <span className="text-faint">on {p.chainName}</span>
            </span>
            {p.status === "pending" ? (
              <button disabled={wallet.busy !== null} onClick={async () => { await wallet.grant(p.id, setStep); setStep(null); }} className="shrink-0 text-accent hover:brightness-125 disabled:opacity-50">
                {wallet.busy === p.id ? <Loader2 className="size-3 animate-spin" /> : "Grant"}
              </button>
            ) : (
              <span className="shrink-0 text-good">Active</span>
            )}
            <button onClick={() => wallet.remove(p.id)} className="shrink-0 text-faint hover:text-bad">
              Remove
            </button>
          </div>
          {wallet.busy === p.id && step && <p className="mt-1 text-[11.5px] text-dim">{step}</p>}
        </div>
      ))}
      {wallet.error && <p className="mt-2 text-[11.5px] text-bad">{wallet.error}</p>}
    </Section>
  );
}

function Guards() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["guards"], queryFn: () => api<Guard[]>("/guards"), refetchInterval: 5_000 });
  const active = (data ?? []).filter((g) => g.status === "active" || g.status === "triggered");
  if (active.length === 0) return null;
  return (
    <Section title="Liquidation guards">
      {active.map((g) => (
        <div key={g.id} className="flex items-start gap-2 py-1 text-[12.5px]">
          <ShieldCheck className={`mt-0.5 size-3.5 shrink-0 ${g.status === "triggered" ? "text-warn" : "text-good"}`} />
          <div className="flex-1">
            <div>{g.params.coin ?? `${g.params.collateral}/${g.params.debt} on ${g.params.chain}`}</div>
            <div className="text-faint">
              {g.venue === "hyperliquid" ? `${g.lastValue?.toFixed(1) ?? "—"}% to liquidation · acts at ${g.params.triggerDistancePct}%` : `acts below HF ${g.params.healthFactorThreshold}`}
            </div>
          </div>
          <button onClick={async () => { await api(`/guards/${g.id}`, { method: "DELETE" }); qc.invalidateQueries({ queryKey: ["guards"] }); }} className="text-[11.5px] text-faint hover:text-bad">
            Stop
          </button>
        </div>
      ))}
    </Section>
  );
}
