// One view of everything a wallet holds: balances, Hyperliquid positions, Aave v3 and v4 accounts, guards.
import type { Address } from "viem";
import * as aave from "./adapters/aave";
import * as aaveV4 from "./adapters/aaveV4";
import * as hl from "./adapters/hyperliquid";
import { listGuards } from "./guards";
import { walletBalances } from "./wallet";

const settle = async <T>(p: Promise<T>): Promise<{ data: T | null; error: string | null }> => {
  try {
    return { data: await p, error: null };
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message.slice(0, 160) : String(err) };
  }
};

/** `address` holds the EVM funds. `hlAddress` is the Hyperliquid account. */
export async function getPositions(userId: string, address: Address, hlAddress: Address = address) {
  const [balances, hyper, aaveAccounts, v4, guards] = await Promise.all([
    settle(walletBalances(address)),
    settle(hl.getAccount(hlAddress)),
    settle(Promise.all((["ethereum", "arbitrum", "base"] as const).map((c) => aave.getAccount(c, address).then((a) => ({ ...a, chainKey: c })))) ),
    settle(aaveV4.getPositions(address)),
    settle(listGuards(userId)),
  ]);
  return {
    address,
    asOf: new Date().toISOString(),
    balances: balances.data ?? [],
    hyperliquid: hyper.data ?? { user: hlAddress, accounts: [], positions: [] },
    aave: (aaveAccounts.data ?? []).filter((a) => a.collateralUsd > 0.01 || a.debtUsd > 0.01),
    /** Aave v4 on Ethereum: one position for each spoke. */
    aaveV4: (v4.data ?? []).filter((p) => p.suppliedUsd > 0.01 || p.debtUsd > 0.01),
    guards: (guards.data ?? []).filter((g) => g.status === "active" || g.status === "triggered"),
    // A source that failed is listed here. A missing position is then not read as "no position".
    errors: Object.entries({ balances: balances.error, hyperliquid: hyper.error, aave: aaveAccounts.error, aaveV4: v4.error, guards: guards.error }).flatMap(([k, v]) => (v ? [`${k}: ${v}`] : [])),
  };
}
