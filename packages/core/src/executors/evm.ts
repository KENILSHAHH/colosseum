// Send agent-built EVM transactions from the user's agent wallet, in order, and read each receipt.
import type { EvmTx } from "../adapters/evm";
import { CHAINS, type ChainKey } from "../registry/chains";
import { publicClient, signerClient } from "../wallet";

export interface SentTx { hash: string; explorer: string; block: number; description: string; contractAddress: string | null; gasUsed: string }

export async function sendTransactions(userId: string, chain: ChainKey, txs: EvmTx[]): Promise<SentTx[]> {
  const wallet = await signerClient(userId, chain);
  const reader = publicClient(chain);
  const sent: SentTx[] = [];
  for (const [i, tx] of txs.entries()) {
    let hash: `0x${string}`;
    try {
      hash = await wallet.sendTransaction({ to: tx.to ?? undefined, data: tx.data, value: BigInt(tx.value) } as never);
    } catch (err) {
      const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
      const hint = /insufficient funds|gas required exceeds/i.test(String(err)) ? ` The agent wallet needs ${chain === "tempo" ? "a fee stablecoin" : "native gas"} on ${CHAINS[chain].name}.` : "";
      throw new Error(`Transaction ${i + 1} of ${txs.length} ("${tx.description}") was not sent: ${msg}.${hint} ${sent.length} earlier transaction(s) are final: ${sent.map((s) => s.hash).join(", ") || "none"}.`);
    }
    const r = await reader.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (r.status !== "success") throw new Error(`Transaction ${i + 1} ("${tx.description}") reverted on-chain: ${hash}. Earlier transactions are final.`);
    sent.push({ hash, explorer: `${CHAINS[chain].explorer}/tx/${hash}`, block: Number(r.blockNumber), description: tx.description, contractAddress: r.contractAddress ?? null, gasUsed: r.gasUsed.toString() });
  }
  return sent;
}
