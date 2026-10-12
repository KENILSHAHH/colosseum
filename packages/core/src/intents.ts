// An intent is a state-changing request that waits for the user's confirmation.
// The agent can create intents. Only the user can confirm them. Plain code executes them.
import { randomUUID } from "node:crypto";
import { config } from "./config";
import { sha256Hex, stableStringify } from "./crypto";
import { sql } from "./db";

export type IntentKind =
  | "hl_open_position"
  | "hl_close_position"
  | "hl_tpsl"
  | "hl_cancel_order"
  | "hl_deposit"
  | "hl_spot_order"
  | "hl_action"
  | "sol_swap"
  | "solana_tx"
  | "sign_typed_data"
  | "guard_create"
  | "job_create"
  | "aave_supply_borrow"
  | "bridge"
  | "evm_transactions";

export type IntentStatus = "pending" | "confirmed" | "executing" | "done" | "failed" | "rejected" | "expired";

export interface Intent {
  id: string;
  userId: string;
  kind: IntentKind;
  params: Record<string, unknown>;
  preview: Record<string, unknown>;
  intentHash: string;
  status: IntentStatus;
  feeUsd: number;
  result: Record<string, unknown> | null;
  createdAt: string;
}

const INTENT_TTL_MS = 5 * 60_000;

interface Row { id: string; user_id: string; kind: IntentKind; params: Record<string, unknown>; preview: Record<string, unknown>; intent_hash: string; status: IntentStatus; fee_usd: string; result: Record<string, unknown> | null; created_at: Date }

const toIntent = (r: Row): Intent => ({
  id: r.id, userId: r.user_id, kind: r.kind, params: r.params, preview: r.preview, intentHash: r.intent_hash,
  status: r.status, feeUsd: Number(r.fee_usd), result: r.result, createdAt: r.created_at.toISOString(),
});

export async function createIntent(args: { userId: string; kind: IntentKind; params: Record<string, unknown>; preview: Record<string, unknown> }): Promise<Intent> {
  const id = randomUUID();
  const intentHash = sha256Hex(stableStringify({ kind: args.kind, params: args.params, user: args.userId }));
  const feeUsd = args.kind === "guard_create" ? 0 : config().PRICE_ACTION_USD;
  const [row] = await sql()<Row[]>`
    insert into intents (id, user_id, kind, params, preview, intent_hash, fee_usd)
    values (${id}, ${args.userId}, ${args.kind}, ${sql().json(args.params as never)}, ${sql().json(args.preview as never)}, ${intentHash}, ${feeUsd})
    returning *`;
  return toIntent(row!);
}

export async function getIntent(id: string, userId: string): Promise<Intent | null> {
  const [row] = await sql()<Row[]>`select * from intents where id = ${id} and user_id = ${userId}`;
  return row ? toIntent(row) : null;
}

export async function listIntents(userId: string, limit = 30): Promise<Intent[]> {
  const rows = await sql()<Row[]>`select * from intents where user_id = ${userId} order by created_at desc limit ${limit}`;
  return rows.map(toIntent);
}

/**
 * Atomic status change. It returns null when the intent is not in `from`.
 * A double click on "Confirm" therefore executes once.
 */
export async function transition(id: string, userId: string, from: IntentStatus, to: IntentStatus, result?: Record<string, unknown>): Promise<Intent | null> {
  const [row] = await sql()<Row[]>`
    update intents set status = ${to}, result = coalesce(${result ? sql().json(result as never) : null}, result), updated_at = now()
    where id = ${id} and user_id = ${userId} and status = ${from}
    returning *`;
  return row ? toIntent(row) : null;
}

export function isExpired(intent: Intent): boolean {
  return Date.now() - new Date(intent.createdAt).getTime() > INTENT_TTL_MS;
}
