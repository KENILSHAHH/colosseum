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
  // A Bedrock id (us.anthropic.claude-opus-5-5 or anthropic.claude-opus-5-5) is priced as the Claude id.
  const id = model.replace(/^(?:[a-z]+\.)?anthropic\./, "");
  const p = Object.entries(PRICES).find(([k]) => id.startsWith(k))?.[1] ?? FALLBACK;
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

/**
 * Record the usage of one prompt. The SDK reports the usage of the whole conversation so far (a resumed session continues the total),
 * so the usage of this prompt is the difference to the last total stored for the session and the model.
 */
export async function recordUsage(args: { userId: string; sessionId: string | null; modelUsage: Record<string, TokenUsage & { costUSD?: number }> }) {
  let cost = 0;
  // The flat price goes on the first model row, so the sum of the rows is the price of the prompt.
  let price = promptPriceUsd();
  for (const [model, total] of Object.entries(args.modelUsage)) {
    const sid = args.sessionId ?? "";
    const [last] = await sql()<{ input: string; output: string; cache_read: string; cache_write: string; cost_usd: string }[]>`
      select input, output, cache_read, cache_write, cost_usd from usage_snapshots where session_id = ${sid} and model = ${model}`;
    const prev = last
      ? { inputTokens: Number(last.input), outputTokens: Number(last.output), cacheReadInputTokens: Number(last.cache_read), cacheCreationInputTokens: Number(last.cache_write), costUSD: Number(last.cost_usd) }
      : null;
    // A total lower than the stored one means a new counter: then the total is the usage of this prompt.
    const grows = prev && total.inputTokens >= prev.inputTokens && total.outputTokens >= prev.outputTokens && total.cacheReadInputTokens >= prev.cacheReadInputTokens;
    const u: TokenUsage = grows
      ? { inputTokens: total.inputTokens - prev!.inputTokens, outputTokens: total.outputTokens - prev!.outputTokens, cacheReadInputTokens: total.cacheReadInputTokens - prev!.cacheReadInputTokens, cacheCreationInputTokens: Math.max(0, total.cacheCreationInputTokens - prev!.cacheCreationInputTokens) }
      : total;
    // The SDK prices each model itself. Its figure is preferred; the table here is the fallback.
    const sdkCost = typeof total.costUSD === "number" ? (grows ? total.costUSD - prev!.costUSD : total.costUSD) : null;
    const c = sdkCost !== null && sdkCost >= 0 ? sdkCost : claudeCostUsd(model, u);
    cost += c;
    await sql()`insert into usage (user_id, session_id, model, input_tokens, output_tokens, cache_read, cache_write, cost_usd, charged_usd)
      values (${args.userId}, ${args.sessionId}, ${model}, ${u.inputTokens}, ${u.outputTokens}, ${u.cacheReadInputTokens}, ${u.cacheCreationInputTokens}, ${c}, ${price})`;
    await sql()`insert into usage_snapshots (session_id, model, input, output, cache_read, cache_write, cost_usd)
      values (${sid}, ${model}, ${total.inputTokens}, ${total.outputTokens}, ${total.cacheReadInputTokens}, ${total.cacheCreationInputTokens}, ${total.costUSD ?? 0})
      on conflict (session_id, model) do update set input = excluded.input, output = excluded.output, cache_read = excluded.cache_read, cache_write = excluded.cache_write, cost_usd = excluded.cost_usd`;
    price = 0;
  }
  return { costUsd: cost, chargedUsd: promptPriceUsd() };
}

export async function recordCharge(args: { userId: string; kind: "prompt" | "action" | "guard"; amountUsd: number; reference?: string | null; detail?: unknown }) {
  await sql()`insert into charges (user_id, kind, amount_usd, reference, detail)
    values (${args.userId}, ${args.kind}, ${args.amountUsd}, ${args.reference ?? null}, ${args.detail ? sql().json(args.detail as never) : null})`;
}
