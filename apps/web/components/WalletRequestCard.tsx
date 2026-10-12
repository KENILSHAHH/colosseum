"use client";

import { useConnectWallet, useWallets } from "@privy-io/react-auth";
import { useQueryClient } from "@tanstack/react-query";
import { Check, ExternalLink, Loader2, PenLine } from "lucide-react";
import { useState } from "react";
import { short, type WalletRequest } from "@/lib/api";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (v: string) => `0x${BigInt(v || "0").toString(16)}`;

/** Transactions that the agent prepared for the user's own wallet. The user confirms them in the wallet. */
export function WalletRequestCard({ request }: { request: WalletRequest }) {
  const qc = useQueryClient();
  const { wallets } = useWallets();
  const { connectWallet } = useConnectWallet();
  const [step, setStep] = useState<string | null>(null);
  const [hashes, setHashes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const wallet = wallets.find((w) => w.address.toLowerCase() === request.owner.toLowerCase());

  async function sign() {
    if (!wallet) return connectWallet();
    setError(null);
    try {
      setStep(`Switch to ${request.chainName}`);
      await wallet.switchChain(request.chainId);
      const provider = await wallet.getEthereumProvider();
      const done: string[] = [];
      // One transaction at a time: every wallet supports it, and each one waits for the one before.
      for (const [i, t] of request.transactions.entries()) {
        setStep(`Confirm ${i + 1} of ${request.transactions.length} in your wallet`);
        const hash = (await provider.request({ method: "eth_sendTransaction", params: [{ from: wallet.address, to: t.to, data: t.data, value: hex(t.value) }] })) as string;
        setStep(`Wait for ${i + 1} of ${request.transactions.length}`);
        let receipt: { status: string } | null = null;
        for (let n = 0; n < 90 && !receipt; n++) {
          receipt = (await provider.request({ method: "eth_getTransactionReceipt", params: [hash] })) as { status: string } | null;
          if (!receipt) await wait(2000);
        }
        if (!receipt) throw new Error(`Transaction ${i + 1} is not confirmed yet. Look in your wallet.`);
        if (receipt.status !== "0x1") throw new Error(`Transaction ${i + 1} failed: ${hash}. The ones before it are final.`);
        done.push(hash);
        setHashes([...done]);
      }
      for (const k of ["positions", "balances"]) qc.invalidateQueries({ queryKey: [k] });
    } catch (e) {
      setError(e instanceof Error ? e.message.split("\n")[0]! : "The transactions were not sent");
    } finally {
      setStep(null);
    }
  }

  const finished = hashes.length === request.transactions.length;
  return (
    <div className="my-3 overflow-hidden rounded-xl border border-line bg-panel">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 text-[13px]">
        <PenLine className="size-3.5 text-accent" />
        <span className="font-medium">Sign in your wallet</span>
        <span className="text-faint">· {request.chainName} · {short(request.owner)}</span>
        {finished && <span className="ml-auto text-[12px] text-good">Done</span>}
      </div>
      <div className="space-y-1.5 px-4 py-3 text-[13px]">
        <p className="leading-relaxed">{request.summary}</p>
        {request.transactions.map((t, i) => (
          <div key={i} className="flex items-center gap-2 text-[12.5px] text-dim">
            {hashes[i] ? <Check className="size-3.5 text-good" /> : <span className="w-3.5 text-center text-faint">{i + 1}</span>}
            <span className="min-w-0 flex-1 truncate">{t.description}</span>
            {hashes[i] && (
              <a href={`${request.explorer}/tx/${hashes[i]}`} target="_blank" rel="noreferrer" className="text-faint hover:text-ink">
                <ExternalLink className="size-3.5" />
              </a>
            )}
          </div>
        ))}
        {error && <p className="text-[12.5px] text-bad">{error}</p>}
      </div>
      {!finished && (
        <div className="border-t border-line px-4 py-2.5">
          <button disabled={step !== null} onClick={sign} className="flex items-center gap-2 rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-60">
            {step && <Loader2 className="size-3.5 animate-spin" />}
            {step ?? (wallet ? `Sign ${request.transactions.length} ${request.transactions.length === 1 ? "transaction" : "transactions"}` : "Connect your wallet")}
          </button>
        </div>
      )}
    </div>
  );
}
