// Prompt price (flat) and measured Claude usage.
// Model prices: https://platform.claude.com/docs/en/about-claude/pricing (USD per million tokens).
import { config } from "../config";
import { sql } from "../db";

interface Price { input: number; output: number }
const PRICES: Record<string, Price> = {
  "claude-fable-5-1": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
};
/** Unknown models are priced as the most expensive known model. A prompt is then never under-priced. */
const FALLBACK: Price = { input: 10, output: 50 };
const CACHE_READ_FACTOR = 0.1;
const CACHE_WRITE_FACTOR = 1.25;

export interface TokenUsage { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }

export function claudeCostUsd(model: string, u: TokenUsage): number {
  const p = Object.entries(PRICES).find(([id]) => model.startsWith(id))?.[1] ?? FALLBACK;
  return (
    (u.inputTokens * p.input +
      u.cacheReadInputTokens * p.input * CACHE_READ_FACTOR +
      u.cacheCreationInputTokens * p.input * CACHE_WRITE_FACTOR +
      u.outputTokens * p.output) / 1_000_000
  );
}

/** Price charged to the user for one prompt. It is flat. It does not follow the Claude cost. */
export function promptPriceUsd(): number {
  return config().PRICE_PROMPT_USD;
}

export async function recordUsage(args: { userId: string; sessionId: string | null; modelUsage: Record<string, TokenUsage & { costUSD?: number }> }) {
  let cost = 0;
  // The flat price goes on the first model row, so the sum of the rows is the price of the prompt.
  let price = promptPriceUsd();
  for (const [model, u] of Object.entries(args.modelUsage)) {
    const c = claudeCostUsd(model, u);
    cost += c;
    await sql()`insert into usage (user_id, session_id, model, input_tokens, output_tokens, cache_read, cache_write, cost_usd, charged_usd)
      values (${args.userId}, ${args.sessionId}, ${model}, ${u.inputTokens}, ${u.outputTokens}, ${u.cacheReadInputTokens}, ${u.cacheCreationInputTokens}, ${c}, ${price})`;
    price = 0;
  }
  return { costUsd: cost, chargedUsd: promptPriceUsd() };
}

export async function spentTodayUsd(userId: string): Promise<number> {
  const [row] = await sql()<{ s: string | null }[]>`select sum(cost_usd) as s from usage where user_id = ${userId} and created_at > now() - interval '24 hours'`;
  return Number(row?.s ?? 0);
}

/** Budget cap and rate limit per user. One user cannot drain the API key. */
export async function checkBudget(userId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const c = config();
  const spent = await spentTodayUsd(userId);
  if (spent >= c.USER_DAILY_LLM_BUDGET_USD) return { ok: false, reason: `Daily model budget reached (${spent.toFixed(2)} of ${c.USER_DAILY_LLM_BUDGET_USD} USD).` };
  const [row] = await sql()<{ n: string }[]>`select count(distinct date_trunc('second', created_at)) as n from usage where user_id = ${userId} and created_at > now() - interval '1 minute'`;
  if (Number(row?.n ?? 0) >= c.USER_PROMPTS_PER_MINUTE) return { ok: false, reason: "Too many prompts in one minute. Wait and try again." };
  return { ok: true };
}

export async function recordCharge(args: { userId: string; kind: "prompt" | "action" | "guard"; amountUsd: number; reference?: string | null; detail?: unknown }) {
  await sql()`insert into charges (user_id, kind, amount_usd, reference, detail)
    values (${args.userId}, ${args.kind}, ${args.amountUsd}, ${args.reference ?? null}, ${args.detail ? sql().json(args.detail as never) : null})`;
}
