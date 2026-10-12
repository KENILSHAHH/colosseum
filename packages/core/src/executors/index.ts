// Deterministic execution of an intent from the agent wallet: execute → verify → log.
import * as aave from "../adapters/aave";
import type { EvmTx } from "../adapters/evm";
import { recordCharge } from "../billing/pricing";
import { sha256Hex } from "../crypto";
import { sql } from "../db";
import { createGuard, normalizeHlParams, type AaveGuardParams, type HlGuardAction } from "../guards";
import { transition, type Intent } from "../intents";
import type { ChainKey } from "../registry/chains";
import { createJob } from "../jobs";
import { sendTransactions } from "./evm";
import { executeOpen, executeReduce, executeCancel, executeTpsl } from "./hyperliquid";

async function logAction(intent: Intent, chain: string, txHash: string) {
  await sql()`insert into action_log (user_id, intent_id, intent_hash, chain, tx_hash) values (${intent.userId}, ${intent.id}, ${intent.intentHash}, ${chain}, ${txHash})`;
}

async function run(intent: Intent, address: string): Promise<Record<string, unknown>> {
  const p = intent.params as Record<string, any>;
  switch (intent.kind) {
    case "hl_open_position": {
      const fill = await executeOpen(intent.userId, address, { coin: p.coin, side: p.side, marginUsd: p.marginUsd, leverage: p.leverage, slippageBps: p.slippageBps }, String(intent.preview.limitPx));
      await logAction(intent, "hyperliquid", `oid:${fill.orderId}`);
      const guard = p.guard ? await createGuard(intent.userId, "hyperliquid", normalizeHlParams({ coin: fill.coin, triggerDistancePct: p.guard.triggerDistancePct, action: p.guard.action as HlGuardAction })) : null;
      return { ...fill, explorer: `https://app.hyperliquid.xyz/explorer/address/${address}`, guardId: guard?.id ?? null };
    }
    case "hl_close_position": {
      const res = await executeReduce(intent.userId, address, { coin: p.coin, fraction: p.fraction, maxSlippageBps: 100 });
      await logAction(intent, "hyperliquid", `close:${sha256Hex(JSON.stringify(res.fills)).slice(0, 16)}`);
      return res;
    }
    case "hl_tpsl":
      return executeTpsl(intent.userId, address, { coin: p.coin, kind: p.kind, triggerPx: p.triggerPx, fraction: p.fraction });
    case "hl_cancel_order":
      return executeCancel(intent.userId, { coin: p.coin, orderId: p.orderId });
    case "aave_supply_borrow":
    case "bridge":
    case "evm_transactions": {
      const chain: ChainKey = intent.kind === "bridge" ? p.fromChain : p.chain;
      const txs = (intent.preview.transactions as (EvmTx & { chainId?: number })[]).map((t) => ({ to: t.to, data: t.data, value: String(t.value ?? "0"), description: t.description }));
      const receipts = await sendTransactions(intent.userId, chain, txs);
      for (const r of receipts) await logAction(intent, chain, r.hash);
      const extra: Record<string, unknown> = {};
      if (intent.kind === "aave_supply_borrow") extra.account = await aave.getAccount(p.chain, address as `0x${string}`);
      if (intent.kind === "bridge") extra.requestIds = ((intent.preview.steps as { requestId: string | null }[]) ?? []).map((s) => s.requestId).filter(Boolean);
      return { receipts, ...extra };
    }
    case "job_create": {
      const job = await createJob(intent.userId, { name: p.name, condition: p.condition, action: p.action, days: p.days });
      return { jobId: job.id, status: job.status, fires: job.conditionText, expiresAt: job.expiresAt };
    }
    case "guard_create": {
      const guard = await createGuard(intent.userId, p.venue, p.guard as AaveGuardParams);
      return { guardId: guard.id, status: guard.status };
    }
    default:
      throw new Error(`Intent kind "${intent.kind}" has no executor.`);
  }
}

/** Run a claimed intent (status "executing") and store the outcome. It never throws. */
export async function executeIntent(intent: Intent, address: string): Promise<Intent> {
  try {
    const result = await run(intent, address);
    if (intent.feeUsd > 0) await recordCharge({ userId: intent.userId, kind: "action", amountUsd: intent.feeUsd, detail: { intentId: intent.id, kind: intent.kind } });
    return (await transition(intent.id, intent.userId, "executing", "done", result))!;
  } catch (err) {
    return (await transition(intent.id, intent.userId, "executing", "failed", { error: err instanceof Error ? err.message : String(err) }))!;
  }
}
