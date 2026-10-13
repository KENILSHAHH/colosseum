"use client";

import { useState } from "react";

/** Local logos for the chains of this product. Other chains use the LI.FI logo. */
export const CHAIN_LOGO: Record<number, string> = {
  1: "/icons/chain-ethereum.png", 8453: "/icons/chain-base.png", 42161: "/icons/chain-arbitrum.png", 4663: "/icons/chain-robinhood.svg",
  4217: "/icons/chain-tempo.svg", 999: "/icons/chain-hyperliquid.svg", 0: "/icons/chain-solana.svg",
};

/** A token or venue logo with a small chain logo at its corner. A missing logo shows the first letter. */
export function Logo({ src, label, chain, size = "md" }: { src: string | null; label: string; chain?: string | null; size?: "sm" | "md" }) {
  const [broken, setBroken] = useState(false);
  const box = size === "sm" ? "size-5" : "size-8";
  return (
    <span className={`relative shrink-0 ${box}`}>
      {src && !broken ? (
        <img src={src} alt="" onError={() => setBroken(true)} className={`${box} rounded-full bg-raised object-cover`} />
      ) : (
        <span className={`grid ${box} place-items-center rounded-full bg-raised font-bold text-dim ${size === "sm" ? "text-[9px]" : "text-[12px]"}`}>{label.slice(0, 1)}</span>
      )}
      {chain && <img src={chain} alt="" className={`absolute rounded-full border border-panel bg-panel ${size === "sm" ? "-bottom-0.5 -right-1 size-2.5" : "-bottom-0.5 -right-0.5 size-3.5"}`} />}
    </span>
  );
}
