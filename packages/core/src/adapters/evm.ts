// Generic EVM helpers for agent-built transactions: simulation and contract code checks.
import { createPublicClient, http, type Address, type Hex } from "viem";
import { CHAINS, type ChainKey } from "../registry/chains";

export interface EvmTx { to: Address | null; data: Hex; value: string; description: string }

export function evmClient(chain: ChainKey) {
  const info = CHAINS[chain];
  if (info.vm !== "evm") throw new Error(`${info.name} is not an EVM chain.`);
  return createPublicClient({ transport: http(info.rpc()) });
}

/**
 * Simulate a list of transactions from the user's address, in order, on current chain state.
 * It uses eth_simulateV1 so a later call sees the state of an earlier call (approve, then use).
 * When the RPC does not support it, each call is simulated alone and later calls are marked "unverified".
 */
export interface SimResult { index: number; description: string; status: "success" | "revert" | "unverified"; gasUsed: string | null; error: string | null }

export async function simulate(chain: ChainKey, from: Address, txs: EvmTx[]): Promise<{ method: string; note?: string; results: SimResult[] }> {
  const client = evmClient(chain);
  try {
    const sim = await client.simulateCalls({
      account: from,
      calls: txs.map((t) => ({ to: t.to ?? undefined, data: t.data, value: BigInt(t.value) })) as never,
    });
    const results = sim.results as { status: "success" | "failure"; gasUsed?: bigint; error?: { message: string } }[];
    return {
      method: "eth_simulateV1",
      results: results.map((r, i) => ({ index: i, description: txs[i]!.description, status: r.status === "success" ? ("success" as const) : ("revert" as const), gasUsed: r.gasUsed?.toString() ?? null, error: r.status === "success" ? null : (r.error?.message ?? "reverted").slice(0, 300) })),
    };
  } catch (batchError) {
    const results: SimResult[] = [];
    for (const [i, t] of txs.entries()) {
      try {
        const gas = await client.estimateGas({ account: from, to: t.to ?? undefined, data: t.data, value: BigInt(t.value) });
        results.push({ index: i, description: t.description, status: "success", gasUsed: gas.toString(), error: null });
      } catch (err) {
        results.push({ index: i, description: t.description, status: i === 0 ? "revert" : "unverified", gasUsed: null, error: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
      }
    }
    return { method: "eth_estimateGas (single calls)", note: `Batch simulation is not available on this RPC: ${String(batchError).slice(0, 120)}`, results };
  }
}

/** True when the address holds contract code. An address with no code is a wallet or a wrong address. */
export async function hasCode(chain: ChainKey, address: Address) {
  const code = await evmClient(chain).getCode({ address });
  return !!code && code !== "0x";
}
