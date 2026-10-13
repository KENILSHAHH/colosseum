"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Check, Link2, Loader2, LogIn, LogOut, Menu, Plus, ShieldCheck, UserRound, Wallet } from "lucide-react";
import { useEffect, useState } from "react";
import { api, post, short, usd, type Me, type Permission } from "@/lib/api";
import { useLinkedWallet } from "@/lib/linkedWallet";
import { DepositPanel } from "./DepositPanel";
import { MenuContext, MenuItem } from "./MenuItem";
import type { useSession } from "@/lib/session";

interface Guard { id: string; venue: string; params: Record<string, any>; status: string; lastValue: number | null; lastCheck: string | null }

export function Sidebar({ session, onNewChat }: { session: ReturnType<typeof useSession>; onNewChat: () => void }) {
  const { me, signedIn } = session;
  const [collapsed, setCollapsed] = useState(false);
  // The choice stays after a reload. It is read after the first render, so the server and the browser draw the same page.
  useEffect(() => setCollapsed(localStorage.getItem("menu-collapsed") === "1"), []);
  const set = (value: boolean) => {
    setCollapsed(value);
    localStorage.setItem("menu-collapsed", value ? "1" : "0");
  };

  return (
    <MenuContext.Provider value={{ collapsed, expand: () => set(false) }}>
    <aside className={`flex h-full shrink-0 flex-col border-r border-line bg-panel/60 backdrop-blur-xl transition-[width] duration-200 ${collapsed ? "w-[64px]" : "w-[272px]"}`}>
      <div className={`flex items-center gap-2 px-3 pt-4 pb-3 ${collapsed ? "justify-center" : ""}`}>
        <button onClick={() => set(!collapsed)} title={collapsed ? "Open the menu" : "Close the menu"} aria-label={collapsed ? "Open the menu" : "Close the menu"} aria-expanded={!collapsed} className="grid size-9 shrink-0 place-items-center rounded-lg text-dim hover:bg-raised hover:text-ink">
          <Menu className="size-5" />
        </button>
        {!collapsed && (
          <>
            <div className="grid size-7 place-items-center rounded-lg bg-gradient-to-br from-[#9945FF] to-[#14F195] text-sm font-semibold text-black">◆</div>
            <div className="text-[15px] font-semibold tracking-tight">DeFi Agent</div>
          </>
        )}
      </div>

      <button onClick={onNewChat} title="New chat" aria-label="New chat" className={collapsed ? "mx-auto mb-3 grid size-10 place-items-center rounded-lg border border-line text-dim hover:bg-raised hover:text-ink" : "mx-3 mb-3 flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm text-dim hover:bg-raised hover:text-ink"}>
        <Plus className="size-4" /> {!collapsed && "New chat"}
      </button>

      <div className={`flex-1 space-y-1 overflow-y-auto pb-4 ${collapsed ? "px-2" : "px-3"}`}>
        {collapsed && !signedIn && (
          <button onClick={() => (session.authenticated ? set(false) : session.signIn())} title="Sign in" aria-label="Sign in" className="mx-auto grid size-10 place-items-center rounded-lg bg-accent text-white hover:brightness-110">
            {session.authenticated ? <Loader2 className="size-4 animate-spin" /> : <LogIn className="size-4" />}
          </button>
        )}

        {!collapsed && !session.authenticated && (
          <Section title="Account">
            <button disabled={!session.ready} onClick={session.signIn} className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white hover:brightness-110 disabled:opacity-60">
              Sign in or sign up
            </button>
          </Section>
        )}

        {!collapsed && session.authenticated && !signedIn && (
          <Section title="Account">
            {session.error ? (
              <>
                <p className="text-[12px] text-bad">{session.error}</p>
                <button onClick={session.signIn} className="mt-2 flex w-full items-center justify-center rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white hover:brightness-110">
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
            {collapsed ? (
              <button onClick={() => set(false)} title={session.label ?? "Signed in"} aria-label="Account" className="mx-auto grid size-10 place-items-center rounded-lg text-dim hover:bg-raised hover:text-ink">
                <UserRound className="size-[18px]" />
              </button>
            ) : (
              <div className="flex items-center gap-3 px-2.5 py-2">
                <span className="grid size-7 shrink-0 place-items-center rounded-md bg-raised text-dim">
                  <UserRound className="size-4" />
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-dim">{session.label ?? "Signed in"}</span>
                <button onClick={session.signOut} title="Sign out" className="text-faint hover:text-ink">
                  <LogOut className="size-3.5" />
                </button>
              </div>
            )}
            <Balances />
            <DepositPanel me={me} />
            <LinkedWallet me={me} />
            <Paybox />
            <Jobs />
            <Guards />
          </>
        )}
      </div>

    </aside>
    </MenuContext.Provider>
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

/** The one wallet of the user: its balance in USD. A click copies the address. */
function Balances() {
  const { data } = useQuery({ queryKey: ["balances"], queryFn: () => api<Balance>("/billing/balances"), refetchInterval: 30_000 });
  const [copied, setCopied] = useState(false);
  return (
    <MenuItem icon={Wallet} label="Wallet" value={!data ? "…" : data.usd === null ? "not read" : usd(data.usd)}>
      <button
        disabled={!data}
        onClick={async () => { await navigator.clipboard.writeText(data!.address); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
        title={data ? `Copy ${data.address}` : undefined}
        className="flex w-full items-center justify-between gap-2 rounded-md py-1 font-mono text-[11.5px] text-faint hover:text-dim"
      >
        <span>{data ? short(data.address) : "…"}</span>
        {copied ? <Check className="size-3 text-good" /> : <span>Copy</span>}
      </button>
    </MenuItem>
  );
}

/** The user's own wallet. The agent acts from it only inside a permission that the user signed. */
function LinkedWallet({ me }: { me: Me }) {
  const wallet = useLinkedWallet();
  const { data } = useQuery({ queryKey: ["permissions"], queryFn: () => api<Permission[]>("/permissions"), refetchInterval: 10_000, enabled: !!me.linkedWallet });
  const [step, setStep] = useState<string | null>(null);

  if (!me.linkedWallet)
    return (
      <MenuItem icon={Link2} label="Your wallet" value={me.linkedWallet ? short(me.linkedWallet) : undefined}>
        <button disabled={wallet.busy !== null} onClick={wallet.link} className="flex w-full items-center justify-center gap-2 rounded-lg border border-line px-3 py-2 text-[13px] text-dim hover:bg-raised hover:text-ink disabled:opacity-60">
          {wallet.busy === "link" && <Loader2 className="size-3.5 animate-spin" />} Link existing wallet
        </button>
        {wallet.error && <p className="mt-2 text-[11.5px] text-bad">{wallet.error}</p>}
      </MenuItem>
    );

  return (
    <MenuItem icon={Link2} label="Your wallet" value={me.linkedWallet ? short(me.linkedWallet) : undefined}>
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
    </MenuItem>
  );
}

interface Job {
  id: string; name: string; conditionText: string; status: string; lastValue: number | null; lastCheck: string | null;
  result: { error?: string; firedAt?: string } | null;
  repeat: { everySeconds: number; times: number; done: number; next: string | null } | null;
}

const every = (s: number) => (s % 86_400 === 0 ? `${s / 86_400 === 1 ? "daily" : `every ${s / 86_400} days`}` : s % 3600 === 0 ? `every ${s / 3600} h` : `every ${Math.round(s / 60)} min`);
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** Actions that the server runs by itself when their condition is true, once or repeated. */
function Jobs() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["jobs"], queryFn: () => api<Job[]>("/jobs"), refetchInterval: 10_000 });
  const color: Record<string, string> = { active: "text-good", running: "text-warn", done: "text-dim", failed: "text-bad", cancelled: "text-faint", expired: "text-faint" };
  return (
    <MenuItem icon={CalendarClock} label="Scheduled jobs" badge={data?.filter((j) => j.status === "active").length}>
      {!data ? (
        <p className="text-[12px] text-faint">…</p>
      ) : data.length === 0 ? (
        <p className="text-[12px] leading-snug text-faint">No scheduled jobs. Ask the agent, for example: "buy 1 USD of gold every day".</p>
      ) : (
        data.slice(0, 8).map((j) => (
          <div key={j.id} className="border-b border-line py-1.5 text-[12.5px] last:border-0" title={j.result?.error ?? j.name}>
            <div className="flex items-start justify-between gap-2">
              <span className="min-w-0">{j.name}</span>
              {j.status === "active" ? (
                <button onClick={async () => { await api(`/jobs/${j.id}`, { method: "DELETE" }); qc.invalidateQueries({ queryKey: ["jobs"] }); }} className="shrink-0 text-[11.5px] text-faint hover:text-bad">
                  Cancel
                </button>
              ) : (
                <span className={`shrink-0 text-[11.5px] ${color[j.status] ?? "text-faint"}`}>{j.status}</span>
              )}
            </div>
            <div className="text-[11.5px] text-faint">
              {j.repeat ? `${every(j.repeat.everySeconds)} · ${j.repeat.done}/${j.repeat.times} runs` : j.conditionText}
              {j.status === "active" && j.repeat?.next && ` · next ${when(j.repeat.next)}`}
              {j.status === "active" && !j.repeat && j.lastValue !== null && ` · now ${j.lastValue.toLocaleString("en-US", { maximumFractionDigits: 3 })}`}
            </div>
            {j.result?.error && <div className="truncate text-[11.5px] text-bad">{j.result.error}</div>}
          </div>
        ))
      )}
    </MenuItem>
  );
}

/** PayBox (World app): the user signs in to their own PayBox account, and the agent gets its tools. */
function Paybox() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["paybox"], queryFn: () => api<{ available: boolean; connected: boolean }>("/paybox/status") });
  const [busy, setBusy] = useState(false);
  if (!data?.available) return null;
  return (
    <Section title="World (PayBox)">
      {data.connected ? (
        <div className="flex items-center justify-between text-[12.5px]">
          <span className="flex items-center gap-1.5 text-good"><Check className="size-3.5" /> Connected</span>
          <button onClick={async () => { await api("/paybox", { method: "DELETE" }); qc.invalidateQueries({ queryKey: ["paybox"] }); }} className="text-[11.5px] text-faint hover:text-bad">
            Disconnect
          </button>
        </div>
      ) : (
        <button disabled={busy} onClick={async () => { setBusy(true); try { const r = await post<{ url: string }>("/paybox/start"); window.location.href = r.url; } finally { setBusy(false); } }} className="flex w-full items-center justify-center gap-2 rounded-lg border border-line px-3 py-2 text-[13px] text-dim hover:bg-raised hover:text-ink disabled:opacity-60">
          {busy && <Loader2 className="size-3.5 animate-spin" />} Connect PayBox
        </button>
      )}
    </Section>
  );
}

function Guards() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["guards"], queryFn: () => api<Guard[]>("/guards"), refetchInterval: 5_000 });
  const active = (data ?? []).filter((g) => g.status === "active" || g.status === "triggered");
  return (
    <MenuItem icon={ShieldCheck} label="Liquidation guards" badge={active.length}>
      {active.length === 0 && <p className="text-[12px] leading-snug text-faint">No guards. Ask the agent to protect a position from liquidation.</p>}
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
    </MenuItem>
  );
}
