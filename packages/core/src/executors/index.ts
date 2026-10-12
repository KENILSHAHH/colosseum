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
import { encodeFunctionData, erc20Abi } from "viem";
import { HL_BRIDGE_ARBITRUM } from "../adapters/hyperliquid";
import { USDC } from "../registry/chains";
import { getOrCreateWallet } from "../wallet";
import { getSolanaWallet, solanaSign, solanaSignAndSend } from "../privy";
import * as jupiter from "../adapters/jupiter";
import { executeOpen, executeReduce, executeCancel, executeHlAction, executeSpotOrder, executeTpsl } from "./hyperliquid";

async function logAction(intent: Intent, chain: string, txHash: string) {
  await sql()`insert into action_log (user_id, intent_id, intent_hash, chain, tx_hash) values (${intent.userId}, ${intent.id}, ${intent.intentHash}, ${chain}, ${txHash})`;
}

async function run(intent: Intent, address: string): Promise<Record<string, unknown>> {
  // Hyperliquid actions use the Hyperliquid account of the user (the legacy key).
  const hlAddress = (await getOrCreateWallet(intent.userId)).hlAddress;
  const p = intent.params as Record<string, any>;
  switch (intent.kind) {
    case "hl_open_position": {
      const fill = await executeOpen(intent.userId, hlAddress, { coin: p.coin, side: p.side, marginUsd: p.marginUsd, leverage: p.leverage, slippageBps: p.slippageBps }, String(intent.preview.limitPx));
      await logAction(intent, "hyperliquid", `oid:${fill.orderId}`);
      const guard = p.guard ? await createGuard(intent.userId, "hyperliquid", normalizeHlParams({ coin: fill.coin, triggerDistancePct: p.guard.triggerDistancePct, action: p.guard.action as HlGuardAction })) : null;
      return { ...fill, explorer: `https://app.hyperliquid.xyz/explorer/address/${hlAddress}`, guardId: guard?.id ?? null };
    }
    case "hl_close_position": {
      const res = await executeReduce(intent.userId, hlAddress, { coin: p.coin, fraction: p.fraction, maxSlippageBps: 100 });
      await logAction(intent, "hyperliquid", `close:${sha256Hex(JSON.stringify(res.fills)).slice(0, 16)}`);
      return res;
    }
    case "hl_tpsl":
      return executeTpsl(intent.userId, hlAddress, { coin: p.coin, kind: p.kind, triggerPx: p.triggerPx, fraction: p.fraction });
    case "hl_deposit": {
      // The Hyperliquid account is the legacy key: the wallet sends it the USDC, and it deposits through the official bridge.
      const usdc = USDC.arbitrum!.address as `0x${string}`;
      const amount = BigInt(p.amount);
      const first = await sendTransactions(intent.userId, "arbitrum", [{ to: usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [hlAddress, amount] }), value: "0", description: "Send USDC to the Hyperliquid account" }]);
      const second = await sendTransactions(intent.userId, "arbitrum", [{ to: usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [HL_BRIDGE_ARBITRUM, amount] }), value: "0", description: "Deposit to Hyperliquid" }], { legacy: true });
      return { receipts: [...first, ...second], hyperliquidAccount: hlAddress };
    }
    case "sol_swap": {
      // Jupiter Ultra: a fresh order for the wallet, signed by Privy, then Jupiter lands it.
      const sw = await getSolanaWallet(intent.userId);
      if (!sw?.enabled) throw new Error("The Solana wallet has no server signer yet.");
      const q = await jupiter.quoteSwap({ from: p.from, to: p.to, amount: p.amount, taker: sw.address });
      if (!q.transaction || !q.requestId) throw new Error(`Jupiter gave no transaction: ${q.error ?? "unknown reason"}.`);
      if (q.outAmount < p.minOut) throw new Error(`The price moved: Jupiter now gives ${q.outAmount}, the confirmed minimum was ${p.minOut}.`);
      const res = await jupiter.executeSwap(await solanaSign(sw.walletId, q.transaction), q.requestId);
      if (res.status !== "Success") throw new Error(`Jupiter did not land the swap: ${res.error ?? res.status}.`);
      return { signature: res.signature, explorer: `https://solscan.io/tx/${res.signature}`, inAmount: q.inAmount, outAmount: q.outAmount };
    }
    case "solana_tx": {
      const sw = await getSolanaWallet(intent.userId);
      if (!sw?.enabled) throw new Error("The Solana wallet has no server signer yet.");
      const signature = await solanaSignAndSend(sw.walletId, p.transaction);
      return { signature, explorer: `https://solscan.io/tx/${signature}` };
    }
    case "hl_action":
      return executeHlAction(intent.userId, p.method, p.params);
    case "hl_spot_order":
      return executeSpotOrder(intent.userId, { pair: p.pair, side: p.side, usd: p.usd, slippageBps: p.slippageBps });
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
      const job = await createJob(intent.userId, { name: p.name, condition: p.condition, action: p.action, days: p.days, repeat: p.repeat });
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
