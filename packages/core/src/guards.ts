// Liquidation Guard: trigger logic, idempotent claim, bounded supervisor, deterministic unwind.
// The trigger and the unwind are plain code. Claude only picks one of the actions that the user approved.
import { randomUUID } from "node:crypto";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { HlPosition } from "./adapters/hyperliquid";
import { GUARD_SUPERVISOR_PROMPT } from "./agent/prompts";
import { claudeClient } from "./claude";
import { claudeConfigured, config } from "./config";
import { sql } from "./db";
import * as aave from "./adapters/aave";
import type { EvmTx } from "./adapters/evm";
import { sendTransactions } from "./executors/evm";
import { executeAddMargin, executeReduce } from "./executors/hyperliquid";
import type { ChainKey } from "./registry/chains";
import { getOrCreateWallet } from "./wallet";

export type HlGuardAction = "full_close" | "partial_deleverage" | "add_margin";

export interface HlGuardParams {
  coin: string;
  /** Act when the mark price is within this percent of the liquidation price. */
  triggerDistancePct: number;
  /** Actions the user approved. The first entry is the default. */
  allowedActions: HlGuardAction[];
  maxSlippageBps: number;
  /** Fraction closed by partial_deleverage. Hard limit set in code: 0.25 to 0.75. */
  partialFraction: number;
  /** Margin added by add_margin, in USD. Hard limit: at most this amount per firing. */
  addMarginUsd: number;
}

/**
 * Aave guard. The agent builds the unwind (its own flash-loan contract or an Aave adapter call) when the user
 * asks for protection, and stores the transaction that starts it. The watcher sends that exact transaction
 * from the agent wallet when the health factor is below the threshold. No model call is on this path.
 */
export interface AaveGuardParams {
  chain: aave.AaveChain;
  healthFactorThreshold: number;
  triggerTx: EvmTx;
  /** Plain description of the unwind, shown to the user. */
  description: string;
  unwindContract?: string | null;
}

export async function evaluateAaveGuard(guard: Guard): Promise<{ state: "closed" | "safe" | "triggered"; healthFactor: number | null }> {
  const p = guard.params as AaveGuardParams;
  const { address } = await getOrCreateWallet(guard.userId);
  const account = await aave.getAccount(p.chain, address);
  if (account.healthFactor === null) return { state: "closed", healthFactor: null };
  return { state: account.healthFactor < p.healthFactorThreshold ? "triggered" : "safe", healthFactor: account.healthFactor };
}

export async function executeAaveGuard(guard: Guard) {
  const p = guard.params as AaveGuardParams;
  const { address } = await getOrCreateWallet(guard.userId);
  const sent = await sendTransactions(guard.userId, p.chain as ChainKey, [p.triggerTx]);
  const after = await aave.getAccount(p.chain, address);
  return { sent, healthFactorAfter: after.healthFactor, debtUsdAfter: after.debtUsd };
}

export interface Guard {
  id: string;
  userId: string;
  venue: "hyperliquid" | "aave";
  params: HlGuardParams | AaveGuardParams;
  status: "active" | "triggered" | "done" | "cancelled" | "failed";
  lastValue: number | null;
  lastCheck: string | null;
  createdAt: string;
}

interface Row { id: string; user_id: string; venue: Guard["venue"]; params: Guard["params"]; status: Guard["status"]; last_value: string | null; last_check: Date | null; created_at: Date }
const toGuard = (r: Row): Guard => ({ id: r.id, userId: r.user_id, venue: r.venue, params: r.params, status: r.status, lastValue: r.last_value === null ? null : Number(r.last_value), lastCheck: r.last_check?.toISOString() ?? null, createdAt: r.created_at.toISOString() });

export function normalizeHlParams(input: { coin: string; triggerDistancePct: number; action: HlGuardAction; maxSlippageBps?: number }): HlGuardParams {
  // A full close is always allowed as the last resort.
  const allowed: HlGuardAction[] = input.action === "full_close" ? ["full_close"] : [input.action, "full_close"];
  return { coin: input.coin, triggerDistancePct: input.triggerDistancePct, allowedActions: allowed, maxSlippageBps: input.maxSlippageBps ?? 100, partialFraction: 0.5, addMarginUsd: 0 };
}

export async function createGuard(userId: string, venue: Guard["venue"], params: Guard["params"]): Promise<Guard> {
  const [row] = await sql()<Row[]>`insert into guards (id, user_id, venue, params) values (${randomUUID()}, ${userId}, ${venue}, ${sql().json(params as never)}) returning *`;
  return toGuard(row!);
}

export async function listGuards(userId?: string, status?: Guard["status"]): Promise<Guard[]> {
  const rows = await sql()<Row[]>`select * from guards where true ${userId ? sql()`and user_id = ${userId}` : sql()``} ${status ? sql()`and status = ${status}` : sql()``} order by created_at desc limit 500`;
  return rows.map(toGuard);
}

export async function cancelGuard(id: string, userId: string) {
  const rows = await sql()`update guards set status = 'cancelled' where id = ${id} and user_id = ${userId} and status = 'active' returning id`;
  return rows.length > 0;
}

export async function recordCheck(id: string, value: number | null) {
  await sql()`update guards set last_value = ${value}, last_check = now() where id = ${id}`;
}

/** Pure trigger test. `position` is the live position, or undefined when it is closed. */
export function evaluateHlGuard(params: HlGuardParams, position: HlPosition | undefined): { state: "closed" | "safe" | "triggered"; distancePct: number | null } {
  if (!position || position.size === 0) return { state: "closed", distancePct: null };
  if (position.distanceToLiquidation === null) return { state: "safe", distancePct: null };
  const distancePct = position.distanceToLiquidation * 100;
  return { state: distancePct <= params.triggerDistancePct ? "triggered" : "safe", distancePct };
}

/**
 * Claim a firing. Two watchers run the same check. The status update is atomic, so exactly one watcher gets the claim.
 * The idempotency key is also the primary key of guard_actions.
 */
export async function claimFiring(guard: Guard, watcher: string): Promise<string | null> {
  const key = `${guard.id}:${guard.lastCheck ?? "first"}:fire`;
  return sql().begin(async (tx) => {
    const claimed = await tx`update guards set status = 'triggered' where id = ${guard.id} and status = 'active' returning id`;
    if (claimed.length === 0) return null;
    await tx`insert into guard_actions (idempotency_key, guard_id, watcher, decision) values (${key}, ${guard.id}, ${watcher}, ${tx.json({ state: "claimed" })})`;
    return key;
  });
}

const Decision = z.object({ action: z.enum(["full_close", "partial_deleverage", "add_margin"]), reason: z.string() });

/**
 * Ask Claude to choose among the approved actions. Hard rules:
 * - a short timeout and no retries, so a slow or down API never delays the unwind;
 * - an answer outside the approved list is ignored;
 * - every failure returns the default action.
 */
export async function superviseDecision(params: HlGuardParams, position: HlPosition, timeoutMs = 4_000): Promise<{ action: HlGuardAction; reason: string; source: "claude" | "default" }> {
  const fallback = { action: params.allowedActions[0]!, reason: "default action", source: "default" as const };
  if (params.allowedActions.length === 1 || !claudeConfigured()) return fallback;
  try {
    const client = claudeClient({ timeout: timeoutMs, maxRetries: 0 });
    const res = await client.messages.parse({
      model: config().CLAUDE_GUARD_MODEL,
      max_tokens: 1024,
      output_config: { effort: "low", format: zodOutputFormat(Decision) },
      system: [{ type: "text", text: GUARD_SUPERVISOR_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: JSON.stringify({ allowedActions: params.allowedActions, defaultAction: params.allowedActions[0], triggerDistancePct: params.triggerDistancePct, position }) }],
    });
    const d = res.parsed_output;
    if (!d || !params.allowedActions.includes(d.action)) return fallback;
    return { action: d.action, reason: d.reason, source: "claude" };
  } catch {
    return fallback;
  }
}

/** Run the chosen action with the hard limits. Returns the result and the next guard status. */
export async function executeHlGuardAction(guard: Guard, action: HlGuardAction) {
  const p = guard.params as HlGuardParams;
  const { hlAddress: address } = await getOrCreateWallet(guard.userId);
  if (action === "add_margin" && p.addMarginUsd > 0) {
    return { result: await executeAddMargin(guard.userId, { coin: p.coin, usd: p.addMarginUsd }), rearm: true };
  }
  if (action === "partial_deleverage") {
    const fraction = Math.min(0.75, Math.max(0.25, p.partialFraction));
    return { result: await executeReduce(guard.userId, address, { coin: p.coin, fraction, maxSlippageBps: p.maxSlippageBps }), rearm: true };
  }
  return { result: await executeReduce(guard.userId, address, { coin: p.coin, fraction: 1, maxSlippageBps: p.maxSlippageBps, chunks: 3 }), rearm: false };
}

export async function finishFiring(key: string, guard: Guard, outcome: { ok: boolean; decision: unknown; result: unknown; rearm: boolean }) {
  await sql()`update guard_actions set status = ${outcome.ok ? "done" : "failed"}, decision = ${sql().json(outcome.decision as never)}, result = ${sql().json((outcome.result ?? null) as never)} where idempotency_key = ${key}`;
  // A failed action re-arms the guard. The next check then tries again with a new key.
  const next = !outcome.ok || outcome.rearm ? "active" : "done";
  await sql()`update guards set status = ${next}, last_check = now() where id = ${guard.id}`;
}
