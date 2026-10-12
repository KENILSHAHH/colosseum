"use client";

import { useConnectWallet, useWallets } from "@privy-io/react-auth";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Loader2, X } from "lucide-react";
import { useState } from "react";
import { post, short, type Me } from "@/lib/api";

const CHAINS = [
  { id: 8453, name: "Base", native: "ETH" },
  { id: 42161, name: "Arbitrum", native: "ETH" },
  { id: 1, name: "Ethereum", native: "ETH" },
  { id: 10, name: "Optimism", native: "ETH" },
  { id: 137, name: "Polygon", native: "POL" },
  { id: 56, name: "BNB Chain", native: "BNB" },
];
const TOKENS = ["USDC", "USDT", "native", "WBTC", "DAI", "WETH"] as const;

interface Quote {
  chainId: number; chainName: string; symbol: string; expectedOusd: number; etaSeconds: number | null;
  approval: { token: string; spender: string; amount: string } | null;
  transaction: { to: string; data: string; value: string };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
// approve(address,uint256)
const approveData = (spender: string, amount: string) => `0x095ea7b3${spender.slice(2).toLowerCase().padStart(64, "0")}${BigInt(amount).toString(16).padStart(64, "0")}`;

/** Deposit from an own wallet in one flow, or copy the deposit address. Each token becomes OUSD on Tempo. */
export function DepositModal({ me, onClose }: { me: Me; onClose: () => void }) {
  const qc = useQueryClient();
  const { wallets } = useWallets();
  const { connectWallet } = useConnectWallet();
  const [chainId, setChainId] = useState(8453);
  const [symbol, setSymbol] = useState<(typeof TOKENS)[number]>("USDC");
  const [amount, setAmount] = useState("");
  const [step, setStep] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const wallet = wallets.find((w) => w.walletClientType !== "privy" && w.walletClientType !== "privy-v2");
  const chain = CHAINS.find((c) => c.id === chainId)!;
  const address = me.deposit?.address ?? null;
  const auto = !!me.deposit?.enabled;

  async function deposit() {
    if (!wallet) return connectWallet();
    setNote(null);
    try {
      setStep("Get a route");
      const q = await post<Quote>("/deposit/quote", { chainId, symbol, amount, from: wallet.address });
      setStep(`Switch to ${chain.name}`);
      await wallet.switchChain(chainId);
      const provider = await wallet.getEthereumProvider();
      const receipt = async (hash: string) => {
        for (let i = 0; i < 60; i++) {
          const r = await provider.request({ method: "eth_getTransactionReceipt", params: [hash] });
          if (r) return r as { status: string };
          await wait(2000);
        }
        throw new Error("The transaction is not confirmed yet. Look in your wallet.");
      };
      if (q.approval) {
        setStep("Approve the token in your wallet");
        const h = await provider.request({ method: "eth_sendTransaction", params: [{ from: wallet.address, to: q.approval.token, data: approveData(q.approval.spender, q.approval.amount) }] });
        setStep("Wait for the approval");
        if ((await receipt(h as string)).status !== "0x1") throw new Error("The approval failed.");
      }
      setStep("Confirm the deposit in your wallet");
      const hash = await provider.request({ method: "eth_sendTransaction", params: [{ from: wallet.address, ...q.transaction }] });
      setStep("Wait for the deposit");
      if ((await receipt(hash as string)).status !== "0x1") throw new Error("The deposit transaction failed.");
      setNote({ ok: true, text: `Sent. About ${q.expectedOusd.toFixed(2)} OUSD arrives on Tempo${q.etaSeconds ? ` in ${q.etaSeconds} s` : " soon"}.` });
      setAmount("");
      setTimeout(() => qc.invalidateQueries({ queryKey: ["billing"] }), 6_000);
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message.split("\n")[0]! : "The deposit failed" });
    } finally {
      setStep(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 px-4 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-[400px] rounded-2xl border border-line bg-panel p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold">Deposit</h2>
          <button onClick={onClose} className="text-faint hover:text-ink" title="Close">
            <X className="size-4" />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <select value={chainId} onChange={(e) => setChainId(Number(e.target.value))} className="rounded-lg border border-line bg-raised px-2.5 py-2 text-[13px]">
            {CHAINS.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select value={symbol} onChange={(e) => setSymbol(e.target.value as (typeof TOKENS)[number])} className="rounded-lg border border-line bg-raised px-2.5 py-2 text-[13px]">
            {TOKENS.map((t) => <option key={t} value={t}>{t === "native" ? chain.native : t}</option>)}
          </select>
        </div>
        <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" placeholder="Amount" className="mt-2 w-full rounded-lg border border-line bg-raised px-3 py-2 font-mono text-[14px] outline-none placeholder:text-faint focus:border-faint" />
        <button disabled={step !== null || (!!wallet && !Number(amount))} onClick={deposit} className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-[13.5px] font-medium text-black hover:brightness-110 disabled:opacity-50">
          {step && <Loader2 className="size-3.5 animate-spin" />}
          {step ?? (wallet ? `Deposit from ${short(wallet.address)}` : "Connect a wallet")}
        </button>
        {note && <p className={`mt-2 text-[12px] ${note.ok ? "text-good" : "text-bad"}`}>{note.text}</p>}
        <p className="mt-2 text-[11.5px] text-faint">It arrives as OUSD on Tempo. Routes by Jumper.</p>

        {address && (
          <div className="mt-4 border-t border-line pt-4">
            <p className="mb-1.5 text-[12px] text-dim">{auto ? "Or send any token to your deposit address" : "Your deposit address"}</p>
            <button onClick={async () => { await navigator.clipboard.writeText(address); setCopied(true); setTimeout(() => setCopied(false), 1500); }} className="flex w-full items-center justify-between gap-2 rounded-md bg-raised px-2.5 py-2 font-mono text-[11.5px] hover:brightness-125" title="Copy address">
              <span className="truncate">{address}</span>
              {copied ? <Check className="size-3.5 shrink-0 text-good" /> : <Copy className="size-3.5 shrink-0 text-faint" />}
            </button>
            <p className="mt-1.5 text-[11.5px] leading-snug text-faint">
              {auto ? "USDC, USDT, ETH, WBTC and more, on any EVM chain. Each one converts to OUSD on Tempo in about a minute. A token needs a little native gas on its chain." : "Automatic conversion is not on for this wallet yet. Reload the page to turn it on."}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
