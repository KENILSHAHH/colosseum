"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Check, KeyRound, Loader2 } from "lucide-react";
import { useState } from "react";
import { api, short, type Permission } from "@/lib/api";
import { useLinkedWallet } from "@/lib/linkedWallet";

/** A permission the agent asked for on the user's own wallet. The user signs it in the wallet or rejects it. */
export function PermissionCard({ permission }: { permission: Permission }) {
  const wallet = useLinkedWallet();
  const [step, setStep] = useState<string | null>(null);
  // The list holds pending and active permissions. A permission that is not in it was rejected or removed.
  const { data } = useQuery({ queryKey: ["permissions"], queryFn: () => api<Permission[]>("/permissions"), refetchInterval: 10_000 });
  const live = data ? data.find((p) => p.id === permission.id) : permission;
  const status = live?.status ?? "removed";
  const busy = wallet.busy === permission.id;
  const days = Math.max(1, Math.round((new Date(permission.expiresAt).getTime() - Date.now()) / 86_400_000));

  return (
    <div className="my-3 overflow-hidden rounded-xl border border-line bg-panel">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 text-[13px]">
        <KeyRound className="size-3.5 text-accent" />
        <span className="font-medium">Permission on your wallet</span>
        <span className="text-faint">· {permission.chainName} · {short(permission.owner)}</span>
        <span className={`ml-auto text-[12px] ${status === "active" ? "text-good" : status === "pending" ? "text-warn" : "text-faint"}`}>
          {status === "active" ? "Granted" : status === "pending" ? "Needs your signature" : "Not active"}
        </span>
      </div>
      <div className="space-y-2.5 px-4 py-3 text-[13px]">
        <p className="leading-relaxed">{permission.reason}</p>
        {permission.delegateIsContract && <Row label="Used by"><code className="font-mono text-[12px]">{short(permission.delegate)}</code> (a contract)</Row>}
        <Row label="Contracts">{permission.targets.map((t) => <code key={t} className="mr-2 font-mono text-[12px]">{short(t)}</code>)}</Row>
        <Row label="Functions">{permission.functions.map((f) => <code key={f} className="mr-2 block font-mono text-[12px]">{f}</code>)}</Row>
        <Row label="Ends">in {days} {days === 1 ? "day" : "days"}</Row>
        {permission.warnings.map((w) => (
          <div key={w} className="flex gap-2 text-[12.5px] text-warn">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {w}
          </div>
        ))}
        {wallet.error && <p className="text-[12.5px] text-bad">{wallet.error}</p>}
      </div>
      {status === "pending" && (
        <div className="flex items-center gap-2 border-t border-line px-4 py-2.5">
          <button disabled={busy} onClick={async () => { await wallet.grant(permission.id, setStep); setStep(null); }} className="flex items-center gap-2 rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-black hover:brightness-110 disabled:opacity-60">
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />} {busy ? step ?? "Working" : "Grant"}
          </button>
          <button disabled={busy} onClick={() => wallet.remove(permission.id)} className="rounded-lg px-3 py-1.5 text-[13px] text-dim hover:text-ink disabled:opacity-60">
            Reject
          </button>
          <span className="ml-auto text-[11.5px] text-faint">The agent can do only what this card lists.</span>
        </div>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="w-20 shrink-0 text-dim">{label}</span>
      <span className="min-w-0 break-all">{children}</span>
    </div>
  );
}
