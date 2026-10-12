// Run the real agent on many tasks as one user, in test mode: every action stops at its confirmation, so no funds move.
// Usage (on the server): npx tsx --env-file=../../.env scripts/agent-eval.mts <userId> [scenario names...]
// Writes a JSON report next to the script with each step, error, prepared action and reply.
import { writeFileSync } from "node:fs";
import { runChatAgent, sql } from "@app/core";

const SCENARIOS: Record<string, string> = {
  hl_liq: "What is the liquidation price of my BTC position on Hyperliquid?",
  hl_sl: "Add a stop-loss at 80000 on my BTC position on Hyperliquid.",
  hl_tp: "Add a take-profit at 95000 on my BTC long.",
  hl_spot_eth: "Buy 10 USD of spot ETH on Hyperliquid.",
  hl_perp_open: "Open a 3x long on ETH on Hyperliquid with 5 USD margin.",
  hl_close_half: "Close half of my GOLD position on Hyperliquid.",
  hl_withdraw: "Withdraw 5 USDC from Hyperliquid to my wallet on Arbitrum.",
  hl_outcomes: "Show me the Hyperliquid outcome (prediction) markets and bet 2 USD on one that looks interesting.",
  dca_gold: "Buy 1 USD of gold every day for 30 days.",
  dca_eth_hl: "Buy 10 USD of ETH every day for 30 days on Hyperliquid spot.",
  swap_base: "Swap 2 USDC to ETH on Base.",
  bridge: "Move 3 USDC from Base to Arbitrum.",
  aave_v3: "Supply 5 USDC to Aave on Base.",
  aave_v4_rates: "What is the best USDC supply rate on Aave v4 right now, across all chains?",
  aave_v4_supply: "Supply 5 USDC to Aave v4 on Base.",
  morpho: "Deposit 5 USDC into the best Morpho USDC vault on Base.",
  rates: "Where can I earn the most on USDC right now across all my chains?",
  unwind_job: "Close my Aave v4 position on Ethereum if ETH falls below 2000.",
  sl_job_price: "If BTC drops below 75000, close my BTC position on Hyperliquid.",
  world: "Bet 2 USD on a prediction market on world.xyz.",
  polymarket: "Bet 2 USD on a Polymarket market about the next Fed decision.",
  kamino: "Lend 5 USDC on Kamino on Solana.",
  jupiter: "Swap 2 USDC to SOL on Jupiter.",
  robinhood_stock: "Buy 2 USD of a tokenized stock on Robinhood Chain.",
  tempo: "What is my OUSD balance on Tempo and what does a prompt cost?",
  positions: "Show me everything I hold and what is at risk.",
};

const userId = process.argv[2];
if (!userId) throw new Error("Pass a user id.");
const names = process.argv.slice(3).length ? process.argv.slice(3) : Object.keys(SCENARIOS);

async function run(name: string) {
  const started = Date.now();
  const steps: { tool: string; input: string; ok?: boolean; result?: string }[] = [];
  const byId = new Map<string, number>();
  const actions: { kind: string; status: string; preview: string }[] = [];
  let reply = "";
  let error: string | null = null;
  let cost = 0;
  try {
    const prompt = `[Test mode: this is an automatic test. Actions wait for a confirmation that will not come, so prepare each action fully up to that point. Do not ask questions; choose sensible defaults.] ${SCENARIOS[name]}`;
    for await (const ev of runChatAgent({ userId, prompt, dryRun: true })) {
      if (ev.type === "text") reply += ev.delta;
      else if (ev.type === "tool") { byId.set(ev.id, steps.length); steps.push({ tool: ev.name, input: JSON.stringify(ev.input).slice(0, 600) }); }
      else if (ev.type === "tool_result") { const i = byId.get(ev.id); if (i !== undefined) Object.assign(steps[i]!, { ok: !ev.isError && !ev.preview.startsWith("Error:"), result: ev.preview.slice(0, 800) }); }
      else if (ev.type === "intent") actions.push({ kind: ev.intent.kind, status: ev.intent.status, preview: JSON.stringify(ev.intent.preview).slice(0, 400) });
      else if (ev.type === "done") cost = ev.costUsd;
      else if (ev.type === "error") error = ev.message;
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const failed = steps.filter((s) => s.ok === false);
  return { name, prompt: SCENARIOS[name], seconds: Math.round((Date.now() - started) / 1000), cost: Number(cost.toFixed(3)), error, actions, failedSteps: failed.length, steps, reply: reply.trim() };
}

const results: Awaited<ReturnType<typeof run>>[] = [];
const queue = [...names];
await Promise.all(Array.from({ length: 4 }, async () => {
  for (let n = queue.shift(); n; n = queue.shift()) {
    const r = await run(n);
    results.push(r);
    console.log(`${r.name}: ${r.actions.length} action(s) prepared, ${r.failedSteps} failed step(s), ${r.seconds}s, $${r.cost}${r.error ? ` ERROR ${r.error.slice(0, 120)}` : ""}`);
  }
}));
const file = new URL(`./agent-eval-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json`, import.meta.url);
writeFileSync(file, JSON.stringify(results, null, 2));
console.log(`report: ${file.pathname} | total cost $${results.reduce((s, r) => s + r.cost, 0).toFixed(2)}`);
// Pending test actions expire by themselves; mark them rejected so they never appear as waiting.
await sql()`update intents set status = 'rejected' where user_id = ${userId} and status = 'pending' and created_at > now() - interval '2 hours'`;
await sql().end();
