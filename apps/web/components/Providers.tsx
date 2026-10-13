"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import { toSolanaWalletConnectors } from "@privy-io/react-auth/solana";
import { createSolanaRpc, createSolanaRpcSubscriptions } from "@solana/kit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { arbitrum, base, bsc, hyperEvm, mainnet, optimism, polygon, robinhood, tempo } from "viem/chains";

const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";
const SOLANA_RPC = "https://api.mainnet-beta.solana.com";
const SOLANA_WS = "wss://api.mainnet-beta.solana.com";

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } } }));
  if (!PRIVY_APP_ID)
    return (
      <div className="grid h-screen place-items-center px-6 text-center text-sm text-dim">
        <p>
          Sign-in is not configured. Add <code className="font-mono text-ink">PRIVY_APP_ID</code> and <code className="font-mono text-ink">PRIVY_APP_SECRET</code> to <code className="font-mono text-ink">.env</code>, then restart the web app and the API.
        </p>
      </div>
    );
  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        // The Privy dashboard sets the login methods. Each user gets one embedded wallet at the first login.
        appearance: { theme: "dark", accentColor: "#9945FF" },
        // A connected wallet can switch only to these chains (deposits, permissions and signing requests).
        defaultChain: base,
        supportedChains: [base, arbitrum, mainnet, robinhood, tempo, polygon, optimism, bsc, hyperEvm],
        embeddedWallets: { ethereum: { createOnLogin: "all-users" }, solana: { createOnLogin: "all-users" } },
        // Solana wallets such as Phantom can connect, so a user can deposit from them.
        externalWallets: { solana: { connectors: toSolanaWalletConnectors() } },
        solana: { rpcs: { "solana:mainnet": { rpc: createSolanaRpc(SOLANA_RPC), rpcSubscriptions: createSolanaRpcSubscriptions(SOLANA_WS), blockExplorerUrl: "https://solscan.io" } } },
      }}
    >
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </PrivyProvider>
  );
}
