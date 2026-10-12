// Scheduled jobs. The agent prepares an action, proves it in a simulation and stores it with a condition.
// A loop on the server checks each condition. When it is true, the server builds the transactions, simulates them again and sends them.
// No model is in this loop: code checks the condition and code sends the stored action. The agent cannot change a job after the user accepted it.
import { randomBytes } from "node:crypto";
import * as aave from "./adapters/aave";
import * as aaveV4 from "./adapters/aaveV4";
import * as evm from "./adapters/evm";
import type { EvmTx } from "./adapters/evm";
import * as hl from "./adapters/hyperliquid";
import { config } from "./config";
import { sql } from "./db";
import { getLinkedWallet, wrapDelegatedTransactions, type DelegationChain } from "./delegation";
import { sendTransactions } from "./executors/evm";
import { CHAINS, type ChainKey } from "./registry/chains";
import { isSponsored, simulateSponsored } from "./sponsor";
import { buildAaveV4Unwind } from "./unwind";
import { getOrCreateWallet } from "./wallet";

/** When a job fires. Code evaluates each one from a live source. */
export type JobCondition =
  /** Mark price of a Hyperliquid perp market, used as the price of the asset: ETH, BTC, SOL and more. */
  | { type: "price"; asset: string; op: "below" | "above"; value: number }
  /** Health factor of an Aave v4 position. `spoke` narrows it to one spoke; without it the lowest health factor counts. */
  | { type: "aave_v4_health_factor"; address: string; spoke?: string; below: number }
  | { type: "aave_v3_health_factor"; chain: "ethereum" | "arbitrum" | "base"; address: string; below: number }
  /** A point in time (ISO 8601). */
  | { type: "time"; at: string };

/** What a job does. `wallet` is the agent wallet or the user's own linked wallet (through an active permission). */
export type JobAction =
  /** Transactions fixed when the job was made. Good for a call whose calldata does not go stale, such as an unwind contract. */
  | { type: "transactions"; chain: ChainKey; wallet: "agent" | "linked"; transactions: EvmTx[] }
  /** Aave v4 steps. The Aave API builds the transactions when the job fires, so the amounts are current. */
  | { type: "aave_v4"; wallet: "agent" | "linked"; steps: { action: aaveV4.V4Action; reserveId: string; amount: string; max?: boolean; native?: boolean }[] }
  /** Close a whole Aave v4 position in one transaction with a flash loan. The debt, the collateral and the swap are read when it fires. */
  | { type: "aave_v4_unwind"; wallet: "agent" | "linked"; chain: "ethereum" | "base"; spoke?: string };

export type JobStatus = "active" | "running" | "done" | "failed" | "cancelled" | "expired";

interface Row {
  id: string; user_id: string; name: string; condition: JobCondition; action: JobAction; status: JobStatus;
  last_value: string | null; last_check: Date | null; expires_at: Date; result: Record<string, unknown> | null; created_at: Date;
}
export interface Job {
  id: string; name: string; condition: JobCondition; conditionText: string; action: JobAction; status: JobStatus;
  lastValue: number | null; lastCheck: string | null; expiresAt: string; result: Record<string, unknown> | null; createdAt: string;
}

export function describeCondition(c: JobCondition): string {
  switch (c.type) {
    case "price": return `${c.asset} price ${c.op} ${c.value} USD`;
    case "aave_v4_health_factor": return `Aave v4 health factor${c.spoke ? ` (${c.spoke})` : ""} below ${c.below}`;
    case "aave_v3_health_factor": return `Aave v3 health factor on ${CHAINS[c.chain].name} below ${c.below}`;
    case "time": return `at ${new Date(c.at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  }
}

const view = (r: Row): Job => ({
  id: r.id, name: r.name, condition: r.condition, conditionText: describeCondition(r.condition), action: r.action, status: r.status,
  lastValue: r.last_value === null ? null : Number(r.last_value), lastCheck: r.last_check?.toISOString() ?? null,
  expiresAt: r.expires_at.toISOString(), result: r.result, createdAt: r.created_at.toISOString(),
});

/** Read the live value of a condition. `value` is null when the condition has no number (a time) or the source has no data. */
export async function evaluate(c: JobCondition): Promise<{ value: number | null; met: boolean }> {
  switch (c.type) {
    case "price": {
      const px = (await hl.getMarket(c.asset)).markPx;
      return { value: px, met: c.op === "below" ? px < c.value : px > c.value };
    }
    case "aave_v4_health_factor": {
      const want = c.spoke?.toLowerCase();
      const hfs = (await aaveV4.getPositions(c.address)).filter((p) => !want || p.spoke.toLowerCase() === want).flatMap((p) => (p.healthFactor === null ? [] : [p.healthFactor]));
      if (hfs.length === 0) return { value: null, met: false };
      const hf = Math.min(...hfs);
      return { value: hf, met: hf < c.below };
    }
    case "aave_v3_health_factor": {
      const hf = (await aave.getAccount(c.chain, c.address as `0x${string}`)).healthFactor;
      return { value: hf, met: hf !== null && hf < c.below };
    }
    case "time":
      return { value: null, met: Date.now() >= new Date(c.at).getTime() };
  }
}

/** Build the transactions of an action for this moment, ready for the agent wallet to send. Also returns the address to simulate from. */
export async function buildJobTransactions(userId: string, action: JobAction): Promise<{ chain: ChainKey; from: `0x${string}`; transactions: EvmTx[] }> {
  const agent = (await getOrCreateWallet(userId)).address;
  const linked = action.wallet === "linked" ? await getLinkedWallet(userId) : null;
  if (action.wallet === "linked" && !linked) throw new Error("The user has no linked wallet.");
  let chain: ChainKey;
  let txs: EvmTx[];
  if (action.type === "aave_v4_unwind") {
    const { tx } = await buildAaveV4Unwind(userId, action);
    return { chain: action.chain, from: agent, transactions: [tx] };
  }
  if (action.type === "transactions") {
    chain = action.chain;
    txs = action.transactions;
  } else {
    const built = [];
    for (const s of action.steps) built.push(await aaveV4.buildAction({ ...s, sender: linked ?? agent }));
    const key = built[0]?.chain.key;
    if (!key || built.some((b) => b.chain.key !== key)) throw new Error("The Aave v4 steps must be on one chain that this product supports.");
    chain = key;
    txs = built.flatMap((b) => b.transactions);
  }
  // Calls of the linked wallet go through its permissions. The agent wallet sends the wrapped transactions.
  if (linked) txs = await wrapDelegatedTransactions(userId, chain as DelegationChain, txs);
  return { chain, from: agent, transactions: txs };
}

async function simulateOrThrow(userId: string, chain: ChainKey, from: `0x${string}`, txs: EvmTx[]) {
  // On a sponsored chain, simulate the way the sponsor sends it. A plain call can fail where the real transaction succeeds.
  if (isSponsored(chain)) {
    const r = await simulateSponsored(userId, chain, txs);
    if (!r.ok) throw new Error(`Simulation: ${r.error}`);
    return { method: "sponsored eth_estimateGas", results: txs.map((t, index) => ({ index, description: t.description, status: "success" as const, gasUsed: r.gas, error: null })) };
  }
  const sim = await evm.simulate(chain, from, txs);
  const bad = sim.results.find((r, i) => r.status === "revert" && (i === 0 || sim.method === "eth_simulateV1"));
  if (bad) throw new Error(`Simulation: transaction ${bad.index + 1} reverts (${bad.error}).`);
  return sim;
}

/**
 * Check a new job before it is stored: the condition must have a live value, and the action must pass a simulation now.
 * `allowRevertNow` skips the simulation for an action that can only work after the condition is true (for example an unwind
 * contract that checks the health factor itself). The agent must then prove it on a fork.
 */
export async function checkJob(userId: string, args: { condition: JobCondition; action: JobAction; allowRevertNow?: boolean }) {
  const now = await evaluate(args.condition);
  if (args.condition.type !== "time" && now.value === null) throw new Error("The condition has no live value now. Check the asset name, the address or the spoke.");
  if (now.met) throw new Error(`The condition is true now (value ${now.value ?? "n/a"}). The job would fire at once. Do the action directly, or change the condition.`);
  const built = await buildJobTransactions(userId, args.action);
  const simulation = args.allowRevertNow ? null : await simulateOrThrow(userId, built.chain, built.from, built.transactions);
  return { valueNow: now.value, chain: built.chain, transactions: built.transactions, simulation };
}

export async function createJob(userId: string, args: { name: string; condition: JobCondition; action: JobAction; days: number }): Promise<Job> {
  const id = `job_${randomBytes(8).toString("hex")}`;
  const expires = new Date(Date.now() + Math.min(Math.max(args.days, 1), 365) * 86_400_000);
  const [row] = await sql()<Row[]>`
    insert into jobs (id, user_id, name, condition, action, expires_at)
    values (${id}, ${userId}, ${args.name}, ${sql().json(args.condition as never)}, ${sql().json(args.action as never)}, ${expires})
    returning *`;
  return view(row!);
}

export async function listJobs(userId: string, all = false): Promise<Job[]> {
  const rows = all
    ? await sql()<Row[]>`select * from jobs where user_id = ${userId} order by created_at desc limit 30`
    : await sql()<Row[]>`select * from jobs where user_id = ${userId} and (status in ('active', 'running') or created_at > now() - interval '3 days') order by created_at desc limit 30`;
  return rows.map(view);
}

export async function cancelJob(id: string, userId: string): Promise<boolean> {
  return (await sql()`update jobs set status = 'cancelled' where id = ${id} and user_id = ${userId} and status = 'active' returning id`).length > 0;
}

async function runJob(r: Row) {
  // The status change is atomic, so two loops cannot run one job.
  const [claimed] = await sql()<Row[]>`update jobs set status = 'running' where id = ${r.id} and status = 'active' returning *`;
  if (!claimed) return;
  try {
    const built = await buildJobTransactions(r.user_id, r.action);
    await simulateOrThrow(r.user_id, built.chain, built.from, built.transactions);
    const sent = await sendTransactions(r.user_id, built.chain, built.transactions);
    await sql()`update jobs set status = 'done', result = ${sql().json({ firedAt: new Date().toISOString(), chain: built.chain, transactions: sent } as never)} where id = ${r.id}`;
    console.log(`job ${r.id} (${r.name}) done for ${r.user_id}: ${sent.map((s) => s.hash).join(", ")}`);
  } catch (err) {
    const error = (err instanceof Error ? err.message : String(err)).split("\n")[0]!.slice(0, 400);
    await sql()`update jobs set status = 'failed', result = ${sql().json({ firedAt: new Date().toISOString(), error } as never)} where id = ${r.id}`;
    console.error(`job ${r.id} (${r.name}) failed for ${r.user_id}: ${error}`);
  }
}

let ticking = false;
export async function tickJobs() {
  if (ticking) return;
  ticking = true;
  try {
    await sql()`update jobs set status = 'expired' where status = 'active' and expires_at < now()`;
    const rows = await sql()<Row[]>`select * from jobs where status = 'active' order by created_at`;
    for (const r of rows) {
      try {
        const now = await evaluate(r.condition);
        await sql()`update jobs set last_value = ${now.value}, last_check = now() where id = ${r.id}`;
        if (now.met) await runJob(r);
      } catch (err) {
        // A source that does not answer is not a trigger. The next tick reads it again.
        console.error(`job ${r.id}: the condition was not read:`, err instanceof Error ? err.message.split("\n")[0] : err);
      }
    }
  } finally {
    ticking = false;
  }
}

/** Start the loop in the API process. */
export function startJobRunner() {
  setInterval(() => void tickJobs(), config().JOB_INTERVAL_SECONDS * 1000).unref();
}
