import type { Metadata } from "next";
import { Providers } from "@/components/Providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "DeFi Agent",
  description: "Ask and act across Ethereum, Arbitrum, Base, Robinhood Chain, Hyperliquid, Solana and Tempo.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
      </head>
      <body>
        <div className="aurora" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
          <span />
          <span />
          <span />
        </div>
        <div className="relative z-10 h-full">
          <Providers>{children}</Providers>
        </div>
      </body>
    </html>
  );
}
