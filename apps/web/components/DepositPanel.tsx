"use client";

import { useConnectWallet, useWallets } from "@privy-io/react-auth";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowDownToLine, Check, Copy, Loader2 } from "lucide-react";
import { useState } from "react";
import { post, short, type Me } from "@/lib/api";
import { MenuItem } from "./MenuItem";

const CHAINS = [
  { id: 8453, name: "Base", native: "ETH" },
  { id: 42161, name: "Arbitrum", native: "ETH" },
  { id: 1, name: "Ethereum", native: "ETH" },
];
const TOKENS = ["USDC", "USDT", "native", "WBTC", "DAI", "WETH"] as const;

interface Plan { transaction: { to: string; data: string; value: string } }

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Add money to the one wallet of the user, from an own wallet. The same funds pay for prompts and open positions. */
export function DepositPanel({ me }: { me: Me }) {
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
  const chain = CHAINS.find((c) => c.id === chainId) ?? CHAINS[0]!;
  const agent = me.wallet.address;

  async function deposit() {
    if (!wallet) return connectWallet();
    setNote(null);
    try {
      setStep("Prepare");
      const plan = await post<Plan>("/deposit/transfer", { chainId: chain.id, symbol, amount });
      setStep(`Switch to ${chain.name}`);
      await wallet.switchChain(chain.id);
      const provider = await wallet.getEthereumProvider();
      const confirmed = async (hash: string) => {
        for (let i = 0; i < 60; i++) {
          const r = (await provider.request({ method: "eth_getTransactionReceipt", params: [hash] })) as { status: string } | null;
          if (r) return r.status === "0x1";
          await wait(2000);
        }
        throw new Error("The transaction is not confirmed yet. Look in your wallet.");
      };
      setStep("Confirm in your wallet");
      const hash = await provider.request({ method: "eth_sendTransaction", params: [{ from: wallet.address, ...plan.transaction }] });
      setStep("Wait for the deposit");
      if (!(await confirmed(hash as string))) throw new Error("The deposit failed.");
      setNote({ ok: true, text: "Done. The funds are in your wallet." });
      setAmount("");
      setTimeout(() => { for (const k of ["balances", "positions"]) qc.invalidateQueries({ queryKey: [k] }); }, 4_000);
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message.split("\n")[0]! : "The deposit failed" });
    } finally {
      setStep(null);
    }
  }

  return (
    <MenuItem icon={ArrowDownToLine} label="Deposit">
      <div className="py-1">
        <div className="grid grid-cols-2 gap-1.5">
          <select value={chain.id} onChange={(e) => setChainId(Number(e.target.value))} className="rounded-md border border-line bg-raised px-2 py-1.5 text-[12.5px]">
            {CHAINS.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select value={symbol} onChange={(e) => setSymbol(e.target.value as (typeof TOKENS)[number])} className="rounded-md border border-line bg-raised px-2 py-1.5 text-[12.5px]">
            {TOKENS.map((t) => <option key={t} value={t}>{t === "native" ? chain.native : t}</option>)}
          </select>
        </div>
        <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" placeholder="Amount" className="mt-1.5 w-full rounded-md border border-line bg-raised px-2.5 py-1.5 font-mono text-[13px] outline-none placeholder:text-faint focus:border-faint" />
        <button disabled={step !== null || (!!wallet && !Number(amount))} onClick={deposit} className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-black hover:brightness-110 disabled:opacity-50">
          {step && <Loader2 className="size-3.5 animate-spin" />}
          {step ?? (wallet ? `Deposit from ${short(wallet.address)}` : "Connect a wallet")}
        </button>
        {note && <p className={`mt-2 text-[11.5px] ${note.ok ? "text-good" : "text-bad"}`}>{note.text}</p>}
        <button onClick={async () => { await navigator.clipboard.writeText(agent); setCopied(true); setTimeout(() => setCopied(false), 1500); }} title="Copy your wallet address" className="mt-2 flex w-full items-center justify-between gap-2 text-[11.5px] text-faint hover:text-dim">
          <span>or send to {short(agent)}</span>
          {copied ? <Check className="size-3 text-good" /> : <Copy className="size-3" />}
        </button>
      </div>
    </MenuItem>
  );
}
