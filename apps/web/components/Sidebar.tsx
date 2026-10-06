"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Check, Copy, Loader2, LogOut, Plus, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { api, post, short, usd, type Me, type Permission, type Positions } from "@/lib/api";
import { useLinkedWallet } from "@/lib/linkedWallet";
import type { useSession } from "@/lib/session";

interface Billing {
  totalChargedUsd: number;
  claudeCostUsd: number;
  tokens: number;
  charges: { kind: string; amount_usd: string; reference: string | null; created_at: string }[];
  payment: { ousd: number | null; recipient: string; explorer: string } | null;
}
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
            <AgentWallet me={me} onChange={session.refresh} />
            <LinkedWallet me={me} />
            <Guards />
            <BillingPanel me={me} />
          </>
        )}
      </div>

      <div className="border-t border-line px-4 py-3 text-[11.5px] leading-snug text-faint">
        Mainnet · real funds
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

/** The agent wallet: where the user sends funds, and the controls for how the agent can use them. */
function AgentWallet({ me, onChange }: { me: Me; onChange: () => void }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["positions"], queryFn: () => api<Positions>("/positions"), refetchInterval: 15_000 });
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const w = me.wallet;
  // A chain with a zero balance is not shown. A chain that was not read is shown.
  const held = (data?.balances ?? []).filter((b) => b.error || (b.usdc ?? 0) > 0 || (b.eth ?? 0) > 0);

  const copy = async () => {
    await navigator.clipboard.writeText(w.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  async function withdraw(chain: string, asset: "USDC" | "ETH", amount: number) {
    setBusy(`${chain}-${asset}`);
    setNote(null);
    try {
      const r = await post<{ hash: string }>("/wallet/withdraw", { chain, asset, amount });
      setNote({ ok: true, text: `Sent to your wallet. Tx ${r.hash.slice(0, 12)}…` });
      qc.invalidateQueries({ queryKey: ["positions"] });
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message.split("\n")[0]! : "Withdrawal failed" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Section title="Agent wallet">
      <button onClick={copy} className="flex w-full items-center justify-between gap-2 rounded-md bg-raised px-2 py-1.5 font-mono text-[11.5px] hover:brightness-125" title="Copy address. The server holds the key of this wallet. Withdrawals go to your own wallet only.">
        <span className="truncate">{w.address}</span>
        {copied ? <Check className="size-3.5 shrink-0 text-good" /> : <Copy className="size-3.5 shrink-0 text-faint" />}
      </button>
      {data && held.length === 0 ? (
        <div className="mt-2.5 rounded-md border border-dashed border-line px-3 py-3 text-center">
          <p className="text-[12.5px] font-medium">You do not have any assets yet</p>
          <p className="mt-1 text-[11.5px] leading-snug text-faint">Top up: send any token to the address above.</p>
        </div>
      ) : null}

      <div className="mt-2.5 space-y-1">
        {held.map((b) => (
          <div key={b.chain} className="flex items-center justify-between text-[12.5px]">
            <span className="text-dim">{b.chainName}</span>
            {b.error ? (
              <span className="text-warn">not read</span>
            ) : (
              <span className="flex items-center gap-2 font-mono tabular-nums">
                {(b.usdc ?? 0) > 0 && <>{(b.usdc ?? 0).toFixed(2)} USDC</>}
                {(b.eth ?? 0) > 0 && <span className="text-faint">{(b.eth ?? 0).toFixed(4)} ETH</span>}
                {(b.usdc ?? 0) > 0.01 && (
                  <button disabled={busy !== null} onClick={() => withdraw(b.chain, "USDC", Math.floor((b.usdc ?? 0) * 1e6) / 1e6)} title="Withdraw all USDC to your wallet" className="text-faint hover:text-accent disabled:opacity-40">
                    {busy === `${b.chain}-USDC` ? <Loader2 className="size-3 animate-spin" /> : <ArrowUpRight className="size-3.5" />}
                  </button>
                )}
              </span>
            )}
          </div>
        ))}
      </div>
      {note && <p className={`mt-2 text-[11.5px] ${note.ok ? "text-good" : "text-bad"}`}>{note.text}</p>}

      <label className="mt-3 flex cursor-pointer items-start gap-2 border-t border-line pt-2.5 text-[12.5px]">
        <input type="checkbox" checked={w.autoExecute} onChange={async (e) => { await post("/wallet/settings", { autoExecute: e.target.checked }); onChange(); }} className="mt-0.5 accent-[#d97757]" />
        <span title={w.autoExecute ? "The agent executes at once, up to the limit below." : "Each action waits for your confirmation."}>Act without asking</span>
      </label>
      <div className="mt-2 flex items-center justify-between text-[12.5px]">
        <span className="text-dim">Limit per action</span>
        <select value={w.maxActionUsd} onChange={async (e) => { await post("/wallet/settings", { maxActionUsd: Number(e.target.value) }); onChange(); }} className="rounded-md border border-line bg-raised px-1.5 py-0.5 font-mono text-[12px]">
          {[25, 100, 250, 1000, 5000].concat([25, 100, 250, 1000, 5000].includes(w.maxActionUsd) ? [] : [w.maxActionUsd]).sort((x, y) => x - y).map((v) => (
            <option key={v} value={v}>${v}</option>
          ))}
        </select>
      </div>
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

interface Asset { chainId: number; chainName: string; symbol: string; token: string; amount: number; usd: number | null; native: boolean }

function BillingPanel({ me }: { me: Me }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["billing"], queryFn: () => api<Billing>("/billing"), refetchInterval: 15_000 });
  const assets = useQuery({ queryKey: ["assets"], queryFn: () => api<Asset[]>("/billing/assets"), refetchInterval: 30_000, enabled: me.mppEnabled });
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const pay = data?.payment ?? null;
  const ousd = pay?.ousd ?? null;
  const list = assets.data ?? [];

  async function convert(a: Asset) {
    const key = `${a.chainId}-${a.token}`;
    setBusy(key);
    setNote(null);
    try {
      const r = await post<{ expectedOusd: number; etaSeconds: number | null }>("/billing/topup", { chainId: a.chainId, token: a.token });
      setNote({ ok: true, text: `Sent. About ${r.expectedOusd.toFixed(2)} OUSD arrives on Tempo${r.etaSeconds ? ` in ${r.etaSeconds} s` : " soon"}.` });
      for (const k of ["positions", "assets"]) qc.invalidateQueries({ queryKey: [k] });
      setTimeout(() => qc.invalidateQueries({ queryKey: ["billing"] }), 8_000);
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message.split("\n")[0]! : "The conversion failed" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Section title="Payments · MPP on Tempo">
      <div className="grid grid-cols-2 gap-y-1 text-[12.5px]">
        <span className="text-dim">Per prompt</span>
        <span className="text-right font-mono tabular-nums">{usd(me.pricing.promptUsd)}</span>
        {pay && ousd !== null && ousd > 0 && (
          <>
            <span className="text-dim">Balance on Tempo</span>
            <span className={`text-right font-mono tabular-nums ${ousd < me.pricing.promptUsd ? "text-warn" : ""}`}>{ousd.toFixed(2)} OUSD</span>
          </>
        )}
        {(data?.totalChargedUsd ?? 0) > 0 && (
          <>
            <span className="text-dim">Charged</span>
            <span className="text-right font-mono tabular-nums">{usd(data!.totalChargedUsd)}</span>
          </>
        )}
      </div>
      {!me.mppEnabled && <p className="mt-2 text-[11.5px] leading-snug text-warn">Payment is off on this server. Usage is measured and priced, but not charged.</p>}
      {pay && (
        <>
          {ousd !== null && ousd < me.pricing.promptUsd && (
            <div className="mt-2 rounded-md border border-dashed border-line px-3 py-2.5 text-center">
              <p className="text-[12.5px] font-medium">You have no balance for prompts</p>
              <p className="mt-1 text-[11.5px] leading-snug text-faint">{list.length > 0 ? "Convert a token below." : "Top up your agent wallet first."}</p>
            </div>
          )}
          {list.map((a) => {
            const key = `${a.chainId}-${a.token}`;
            return (
              <button key={key} disabled={busy !== null} onClick={() => convert(a)} title={`Convert ${a.symbol} on ${a.chainName} to OUSD on Tempo`} className="mt-1.5 flex w-full items-center justify-between gap-2 rounded-md border border-line px-2 py-1.5 text-left text-[12px] hover:bg-raised disabled:opacity-50">
                <span className="min-w-0 truncate">
                  {a.amount.toLocaleString("en-US", { maximumFractionDigits: 5 })} {a.symbol} <span className="text-faint">on {a.chainName}</span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5 text-dim">
                  {a.usd !== null && <span className="font-mono tabular-nums">{usd(a.usd)}</span>}
                  {busy === key ? <Loader2 className="size-3 animate-spin" /> : <span className="text-accent">Convert</span>}
                </span>
              </button>
            );
          })}
          {note && <p className={`mt-2 text-[11.5px] ${note.ok ? "text-good" : "text-bad"}`}>{note.text}</p>}
          {list.length > 0 && (
            <p className="mt-2 text-[11px] text-faint">
              To OUSD on Tempo, routes by{" "}
              <a href="https://jumper.xyz" target="_blank" rel="noreferrer" className="underline decoration-dotted hover:text-ink">Jumper</a>
            </p>
          )}
        </>
      )}
      {(data?.charges.length ?? 0) > 0 && (
        <div className="mt-2 max-h-28 space-y-0.5 overflow-y-auto border-t border-line pt-2">
          {data!.charges.slice(0, 12).map((c, i) => (
            <div key={i} className="flex justify-between text-[11.5px] text-faint">
              {pay && c.reference?.startsWith("0x") ? (
                <a href={`${pay.explorer}/tx/${c.reference}`} target="_blank" rel="noreferrer" className="underline decoration-dotted hover:text-ink" title="Payment transaction on Tempo">
                  {c.kind} · {new Date(c.created_at).toLocaleTimeString()}
                </a>
              ) : (
                <span>{c.kind} · {new Date(c.created_at).toLocaleTimeString()}</span>
              )}
              <span className="font-mono tabular-nums">{usd(Number(c.amount_usd))}</span>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}
