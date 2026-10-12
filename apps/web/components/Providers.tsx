"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";

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
        embeddedWallets: { ethereum: { createOnLogin: "all-users" } },
      }}
    >
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </PrivyProvider>
  );
}
