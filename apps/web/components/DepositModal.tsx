"use client";

import { useConnectWallet, useWallets } from "@privy-io/react-auth";
import { useSignAndSendTransaction, useWallets as useSolanaWallets } from "@privy-io/react-auth/solana";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Loader2, X } from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api, post, short, usd, type Me } from "@/lib/api";

/** `id` 0 is Solana: its own wallet and its own assets, used only for Solana actions. `id` -1 is Hyperliquid: USDC goes to the Hyperliquid account. */
const SOLANA = 0;
const HYPERLIQUID = -1;
const CHAINS = [
  { id: 8453, name: "Base", logo: "/icons/chain-base.png" },
  { id: 42161, name: "Arbitrum", logo: "/icons/chain-arbitrum.png" },
  { id: 1, name: "Ethereum", logo: "/icons/chain-ethereum.png" },
  { id: 4663, name: "Robinhood", logo: "/icons/chain-robinhood.svg" },
  { id: 4217, name: "Tempo", logo: "/icons/chain-tempo.svg" },
  { id: HYPERLIQUID, name: "Hyperliquid", logo: "/icons/chain-hyperliquid.svg" },
  { id: SOLANA, name: "Solana", logo: "/icons/chain-solana.svg" },
];
type Token = { symbol: string; label: string; logo: string };
const SOLANA_TOKENS: Token[] = [
  { symbol: "SOL", label: "SOL", logo: "/icons/chain-solana.svg" },
  { symbol: "USDC", label: "USDC", logo: "/icons/usdc.png" },
  { symbol: "USDT", label: "USDT", logo: "/icons/usdt.png" },
];
const TOKENS: Token[] = [
  { symbol: "USDC", label: "USDC", logo: "/icons/usdc.png" },
  { symbol: "USDT", label: "USDT", logo: "/icons/usdt.png" },
  { symbol: "native", label: "ETH", logo: "/icons/eth.png" },
  { symbol: "WBTC", label: "WBTC", logo: "/icons/btc.png" },
  { symbol: "DAI", label: "DAI", logo: "/icons/dai.png" },
  { symbol: "WETH", label: "WETH", logo: "/icons/eth.png" },
];
/** The tokens of each network. Robinhood Chain has no USDC; Tempo has no native coin and pays fees in stablecoins. */
const TOKENS_BY_CHAIN: Record<number, Token[]> = {
  [SOLANA]: SOLANA_TOKENS,
  [HYPERLIQUID]: [{ symbol: "USDC", label: "USDC", logo: "/icons/usdc.png" }],
  4663: [
    { symbol: "native", label: "ETH", logo: "/icons/eth.png" },
    { symbol: "USDG", label: "USDG", logo: "/icons/usdg.png" },
    { symbol: "USDe", label: "USDe", logo: "/icons/usde.png" },
    { symbol: "WETH", label: "WETH", logo: "/icons/eth.png" },
  ],
  4217: [
    { symbol: "USDCe", label: "USDC.e", logo: "/icons/usdc.png" },
    { symbol: "USDT0", label: "USDT0", logo: "/icons/usdt.png" },
    { symbol: "PathUSD", label: "pathUSD", logo: "/icons/chain-tempo.svg" },
    { symbol: "OUSD", label: "OUSD", logo: "/icons/chain-tempo.svg" },
  ],
};

interface Plan { transaction: { to: string; data: string; value: string } }

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const chip = (active: boolean) =>
  `flex items-center gap-2 rounded-xl border px-3 py-2 text-[13px] font-medium ${active ? "border-accent bg-accent/15 text-ink" : "border-line bg-raised text-dim hover:text-ink"}`;

/** Add money to the one wallet of the user: send to the address, or send from a connected wallet. */
export function DepositModal({ me, onClose }: { me: Me; onClose: () => void }) {
  const qc = useQueryClient();
  const { wallets } = useWallets();
  const { connectWallet } = useConnectWallet();
  const [chainId, setChainId] = useState(8453);
  const [symbol, setSymbol] = useState<string>("USDC");
  const [amount, setAmount] = useState("");
  const [step, setStep] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const { wallets: solWallets } = useSolanaWallets();
  const { signAndSendTransaction } = useSignAndSendTransaction();
  const wallet = wallets.find((w) => w.walletClientType !== "privy" && w.walletClientType !== "privy-v2");
  const chain = CHAINS.find((c) => c.id === chainId) ?? CHAINS[0]!;
  const isSolana = chain.id === SOLANA;
  const isHl = chain.id === HYPERLIQUID;
  const tokens = TOKENS_BY_CHAIN[chain.id] ?? TOKENS;
  const token = tokens.find((t) => t.symbol === symbol) ?? tokens[0]!;
  const solAddress = me.solana?.address ?? null;
  // A Solana wallet of the user other than the Privy one, for example Phantom.
  const solWallet = solWallets.find((w) => w.address !== solAddress);
  // While the window is open the balance is read every 5 seconds, so a deposit to the QR address shows at once.
  const { data: bal } = useQuery({ queryKey: ["balances"], queryFn: () => api<{ usd: number | null; solana: { usd: number | null } | null }>("/billing/balances"), refetchInterval: 5_000 });
  const total = bal ? (bal.usd ?? 0) + (bal.solana?.usd ?? 0) : null;
  const [start, setStart] = useState<number | null>(null);
  useEffect(() => { if (start === null && total !== null) setStart(total); }, [start, total]);
  const received = start !== null && total !== null && total - start >= 0.5 ? total - start : null;
  const agent = isSolana ? (solAddress ?? "") : isHl ? me.wallet.hlAddress : me.wallet.address;

  useEffect(() => {
    if (!agent) return setQr(null);
    QRCode.toDataURL(agent, { margin: 1, width: 360, color: { dark: "#000000", light: "#ffffff" } }).then(setQr, () => setQr(null));
  }, [agent]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && step === null && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, step]);

  async function depositSolana() {
    if (!solWallet) return connectWallet({ walletChainType: "solana-only" });
    setNote(null);
    try {
      setStep("Prepare");
      const plan = await post<{ transaction: string }>("/deposit/solana", { symbol: token.symbol, amount, from: solWallet.address });
      setStep("Confirm in your wallet");
      const bytes = Uint8Array.from(atob(plan.transaction), (c) => c.charCodeAt(0));
      await signAndSendTransaction({ transaction: bytes, wallet: solWallet, chain: "solana:mainnet" });
      setNote({ ok: true, text: "Sent. It arrives in your Solana wallet in a few seconds." });
      setAmount("");
      setTimeout(() => qc.invalidateQueries({ queryKey: ["balances"] }), 4_000);
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message.split("\n")[0]! : "The deposit failed" });
    } finally {
      setStep(null);
    }
  }

  async function deposit() {
    if (isSolana) return depositSolana();
    if (!wallet) return connectWallet();
    setNote(null);
    try {
      setStep("Prepare");
      const plan = isHl ? await post<Plan>("/deposit/hyperliquid", { amount }) : await post<Plan>("/deposit/transfer", { chainId: chain.id, symbol: token.symbol, amount });
      const evmChain = isHl ? CHAINS[1]! : chain;
      setStep(`Switch to ${evmChain.name}`);
      await wallet.switchChain(evmChain.id);
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
      if (isHl) {
        setStep("Bridge into Hyperliquid");
        await post("/deposit/hyperliquid/credit", {});
      }
      setNote({ ok: true, text: isHl ? "Sent. The USDC shows on Hyperliquid in about a minute." : "Done. The funds are in your wallet." });
      setAmount("");
      setTimeout(() => { for (const k of ["balances", "positions"]) qc.invalidateQueries({ queryKey: [k] }); }, 4_000);
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message.split("\n")[0]! : "The deposit failed" });
    } finally {
      setStep(null);
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && step === null && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Deposit" className="max-h-full w-full max-w-[440px] overflow-y-auto rounded-2xl border border-line bg-panel p-5 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[18px] font-bold tracking-tight">Deposit</h2>
          <button onClick={onClose} aria-label="Close" className="grid size-8 place-items-center rounded-lg text-dim hover:bg-raised hover:text-ink">
            <X className="size-4" />
          </button>
        </div>

        <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-faint">Network</p>
        <div className="flex flex-wrap gap-2">
          {CHAINS.map((c) => (
            <button key={c.id} onClick={() => { setChainId(c.id); setSymbol((TOKENS_BY_CHAIN[c.id] ?? TOKENS)[0]!.symbol); setNote(null); }} aria-pressed={c.id === chain.id} className={chip(c.id === chain.id)}>
              <img src={c.logo} alt="" className="size-5 rounded-full" /> {c.name}
            </button>
          ))}
        </div>

        <p className="mb-1.5 mt-4 text-[11px] font-medium uppercase tracking-wider text-faint">Asset</p>
        <div className="flex flex-wrap gap-2">
          {tokens.map((t) => (
            <button key={t.symbol} onClick={() => setSymbol(t.symbol)} aria-pressed={t.symbol === symbol} className={chip(t.symbol === symbol)}>
              <img src={t.logo} alt="" className="size-5 rounded-full" /> {t.label}
            </button>
          ))}
        </div>

        <div className="mt-5 flex flex-col items-center rounded-xl border border-line bg-bg/40 p-4">
          <div className="relative rounded-xl bg-white p-2">
            {qr ? <img src={qr} alt={`QR code of ${agent}`} className="size-[168px]" /> : <div className="grid size-[168px] place-items-center"><Loader2 className="size-5 animate-spin text-black" /></div>}
            <img src={chain.logo} alt="" className="absolute left-1/2 top-1/2 size-9 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-white" />
          </div>
          <button
            onClick={async () => { await navigator.clipboard.writeText(agent); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
            title="Copy your wallet address"
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg px-2 py-1.5 font-mono text-[12px] text-dim hover:bg-raised hover:text-ink"
          >
            <span className="break-all text-center">{agent}</span>
            {copied ? <Check className="size-3.5 shrink-0 text-good" /> : <Copy className="size-3.5 shrink-0" />}
          </button>
          {!isHl && <p className="mt-1 text-center text-[12px] text-faint">Send only {token.label} on {chain.name} to this address.</p>}
          {isHl && <p className="mt-1 text-center text-[11.5px] text-faint">This is your Hyperliquid account. Send USDC from another Hyperliquid account, or use the button below to send USDC from Arbitrum (at least 5).</p>}
          {chain.id === 4217 && <p className="mt-1 text-center text-[11.5px] text-faint">Tempo has no gas coin. Your wallet pays the fee in a stablecoin.</p>}
          {isSolana && <p className="mt-1 text-center text-[11.5px] text-faint">Your Solana wallet is separate from your EVM wallet. Funds here are used for Solana actions only.</p>}
        </div>

        <div className="my-4 flex items-center gap-3 text-[11px] uppercase tracking-wider text-faint">
          <span className="h-px flex-1 bg-line" /> or <span className="h-px flex-1 bg-line" />
        </div>

        <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" placeholder={isHl ? "Amount of USDC on Arbitrum" : `Amount of ${token.label}`} className="w-full rounded-lg border border-line bg-raised px-3 py-2 font-mono text-[14px] outline-none placeholder:text-faint focus:border-faint" />
        <button disabled={step !== null || (isSolana ? !!solWallet && !Number(amount) : !!wallet && !Number(amount)) || (isSolana && !solAddress)} onClick={deposit} className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl bg-accent px-3 py-2.5 text-[14px] font-medium text-white hover:brightness-110 disabled:opacity-50">
          {step && <Loader2 className="size-4 animate-spin" />}
          {step ?? (isSolana ? (solWallet ? `Deposit from ${short(solWallet.address)}` : "Connect a Solana wallet to deposit") : wallet ? `Deposit from ${short(wallet.address)}` : "Connect a wallet to deposit")}
        </button>
        {received !== null && <p className="mt-2 text-[12.5px] text-good">Received about {usd(received)}. It is in your wallet now.</p>}
        {note && <p className={`mt-2 text-[12.5px] ${note.ok ? "text-good" : "text-bad"}`}>{note.text}</p>}
      </div>
    </div>,
    document.body,
  );
}
