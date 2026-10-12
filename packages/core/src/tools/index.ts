// Typed DeFi tools for the agent. Handlers run in the API process, outside the agent subprocess.
// Read tools return data. Action tools build a preview, check limits, and execute from the user's agent wallet
// (or wait for a confirmation click when the user turned automatic execution off).
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import * as aave from "../adapters/aave";
import * as aaveV4 from "../adapters/aaveV4";
import * as evm from "../adapters/evm";
import * as hl from "../adapters/hyperliquid";
import * as jupiter from "../adapters/jupiter";
import * as relay from "../adapters/relay";
import { compareLendingRates } from "../adapters/yields";
import { config } from "../config";
import * as delegation from "../delegation";
import { executeIntent } from "../executors/index";
import { createIntent, transition, type Intent, type IntentKind } from "../intents";
import { getPositions } from "../positions";
import { CHAIN_KEYS, CHAINS } from "../registry/chains";
import type { AgentWallet } from "../wallet";

export interface ToolContext {
  userId: string;
  wallet: AgentWallet;
  /** Called when an intent is created and again when its status changes. The API streams it to the browser. */
  onIntent: (intent: Intent) => void;
  /** Called when the agent asks for a permission on the linked wallet. The browser shows a card to sign. */
  onPermission: (permission: delegation.Permission) => void;
}

export const SERVER_NAME = "defi";

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });
const fail = (err: unknown) => ({ content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true });

const RISK_DISCLOSURE =
  "A guard reduces liquidation risk. It cannot guarantee a result. Price gaps, oracle delay and network congestion can cause a liquidation before the guard acts.";

const EVM_CHAINS = ["ethereum", "arbitrum", "base", "robinhood", "tempo", "hyperevm"] as const;
const TxShape = z.object({
  to: z.string().regex(/^0x[0-9a-fA-F]{40}$/).nullable().describe("Target contract. null deploys a contract."),
  data: z.string().regex(/^0x[0-9a-fA-F]*$/),
  value: z.string().regex(/^[0-9]+$/).default("0").describe("Native value in wei"),
  description: z.string().describe("One plain sentence shown to the user"),
});
const toEvmTx = (t: z.infer<typeof TxShape>): evm.EvmTx => ({ to: t.to as `0x${string}` | null, data: t.data as `0x${string}`, value: t.value, description: t.description });

export function buildTools(ctx: ToolContext) {
  const address = ctx.wallet.address;
  const run = <A>(fn: (args: A) => Promise<unknown>) => async (args: A) => {
    try {
      return ok(await fn(args));
    } catch (err) {
      return fail(err);
    }
  };

  /** Create the intent, enforce the per-action limit, then execute it or wait for the user. */
  const act = async (kind: IntentKind, params: Record<string, unknown>, preview: Record<string, unknown>, usdSize: number) => {
    if (usdSize > ctx.wallet.maxActionUsd) {
      throw new Error(`This action is about ${usdSize.toFixed(2)} USD. The user's limit per action is ${ctx.wallet.maxActionUsd} USD. Tell the user. They can raise the limit in the wallet panel.`);
    }
    const intent = await createIntent({ userId: ctx.userId, kind, params, preview });
    ctx.onIntent(intent);
    if (!ctx.wallet.autoExecute) {
      return { status: "AWAITING_USER_CONFIRMATION", intentId: intent.id, preview, note: "The user sees a confirmation card. Do not say that the action ran." };
    }
    const claimed = await transition(intent.id, ctx.userId, "pending", "executing");
    if (!claimed) throw new Error("The intent changed state before execution.");
    const done = await executeIntent(claimed, address);
    ctx.onIntent(done);
    return done.status === "done"
      ? { status: "EXECUTED", intentId: done.id, result: done.result, preview, note: "The user sees a card with this result. Report the real figures and the transaction ids from `result`." }
      : { status: "FAILED", intentId: done.id, error: done.result?.error, note: "Nothing more was executed. Explain the failure plainly. Do not retry the same action without a change." };
  };

  const read = { annotations: { readOnlyHint: true } };

  const tools = [
    // ── Read ────────────────────────────────────────────────────────────────
    tool("wallet_overview", "The user's agent wallet: address, native and USDC balances on Ethereum, Arbitrum and Base, Hyperliquid balances and positions, Aave accounts, active guards. Call it before any action to know what funds exist and where.",
      {}, run(() => getPositions(ctx.userId, address)), read),

    tool("rates_compare", "Compare live supply (lending) rates for one asset across Ethereum, Arbitrum, Base, Solana, HyperEVM, Tempo and Robinhood Chain. Returns rows with APY, TVL and a source link per row.",
      { asset: z.string().describe("Token symbol, for example USDC"), chains: z.array(z.string()).optional().describe("Chain name filter"), minTvlUsd: z.number().optional() },
      run(compareLendingRates), read),

    tool("hl_markets", "Find live Hyperliquid perp markets by name across the core dex and all HIP-3 builder dexes. Returns coin name, asset id, mark price, max leverage, margin mode, collateral token and 24h volume. Several markets can match one word such as gold.",
      { query: z.string().describe("Asset word or exact coin, for example gold, BTC, xyz:GOLD") },
      run(async ({ query }) => {
        const markets = await hl.findMarkets(query);
        return { matches: markets.slice(0, 15), count: markets.length };
      }), read),

    tool("hl_account", "Read a Hyperliquid account: balances per dex and open positions with entry price, liquidation price and distance to liquidation. Default: the agent wallet.",
      { address: z.string().optional() }, run(({ address: a }) => hl.getAccount(a ?? address)), read),

    tool("hl_outcomes", "List Hyperliquid HIP-4 outcome (prediction) markets. Fully collateralized, no leverage.",
      { query: z.string().optional(), limit: z.number().int().max(50).optional() },
      run(({ query, limit }) => hl.listOutcomes(query, limit)), read),

    tool("sol_quote", "Quote a Solana token swap through Jupiter. Read-only.",
      { from: z.string(), to: z.string(), amount: z.number().positive().describe("Amount of the input token in whole units") },
      run(jupiter.quoteSwap), read),

    tool("bridge_quote", "Quote a cross-chain transfer through Relay without sending it. Returns output amount, fee in USD, ETA in seconds and the steps.",
      { fromChain: z.enum(CHAIN_KEYS), toChain: z.enum(CHAIN_KEYS), fromToken: z.string(), toToken: z.string(), amount: z.number().positive() },
      run((a) => relay.quoteBridge({ ...a, user: address, recipient: address })), read),

    tool("bridge_status", "Status of a Relay transfer by request id. Use it after `bridge` to confirm that the funds arrived before the next step.",
      { requestId: z.string() }, run(({ requestId }) => relay.bridgeStatus(requestId)), read),

    tool("aave_account", "Read an Aave v3 account: collateral, debt, health factor. Default: the agent wallet.",
      { chain: z.enum(["ethereum", "arbitrum", "base"]), address: z.string().optional() },
      run(({ chain, address: a }) => aave.getAccount(chain, (a ?? address) as `0x${string}`)), read),

    tool("aave_v4_markets", "List live Aave v4 reserves on every chain where Aave v4 is deployed (the result names the chains; Aave v4 is not on Arbitrum, Robinhood Chain, HyperEVM or Tempo unless the chain list says so). Aave v4 has hubs (shared liquidity) and spokes (markets with their own risk rules). One token can be in several spokes, with a different rate in each. Returns the reserve id for aave_v4_action, the spoke, the hub, supply and borrow APY in percent, the collateral factor and the size.",
      { asset: z.string().optional().describe("Token symbol, for example USDC or WETH"), spoke: z.string().optional().describe("Spoke name, for example Main, Bluechip, Lido"), chain: z.string().optional().describe("Chain name, for example ethereum or base. Default: all Aave v4 chains.") },
      run(async (a) => {
        const [chains, reserves] = await Promise.all([aaveV4.v4Chains(), aaveV4.listReserves(a)]);
        return { aaveV4Chains: chains.map((c) => ({ name: c.name, chainId: c.chainId, agentCanAct: c.key !== null })), count: reserves.length, reserves: reserves.slice(0, 40), source: "https://api.aave.com/graphql" };
      }), read),

    tool("aave_v4_account", "Read the Aave v4 positions of an address on every Aave v4 chain: one position for each spoke, with supplied value, collateral, debt, health factor and net APY. The health factor is separate for each spoke. Default: the agent wallet. Pass the linked wallet address to read the user's own positions.",
      { address: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional() },
      run(async ({ address: a }) => ({ user: a ?? address, positions: await aaveV4.getPositions(a ?? address), source: "https://api.aave.com/graphql" })), read),

    tool("evm_simulate", "Simulate EVM transactions from the agent wallet on live chain state. Read-only. Use it to test calldata or a contract deployment that you built.",
      { chain: z.enum(EVM_CHAINS), transactions: z.array(TxShape).min(1).max(12) },
      run(({ chain, transactions }) => evm.simulate(chain, address, transactions.map(toEvmTx))), read),

    // ── The user's own wallet (linked wallet) ───────────────────────────────
    tool("linked_wallet_overview", "The user's own wallet, when the user linked one: address, balances, Hyperliquid and Aave positions, and the permissions the user granted on it. A permission names contracts, functions, a native value limit and an end date. You can act from this wallet only inside an active permission.",
      {}, run(async () => {
        const linked = await delegation.getLinkedWallet(ctx.userId);
        if (!linked) return { linked: null, note: "No wallet is linked. The user links one with the \"Link existing wallet\" button in the sidebar." };
        const [positions, permissions, upgraded] = await Promise.all([
          getPositions(ctx.userId, linked),
          delegation.listPermissions(ctx.userId),
          Promise.all(delegation.DELEGATION_CHAINS.map(async (c) => [c, await delegation.isUpgraded(c, linked).catch(() => null)] as const)),
        ]);
        return { linked, smartAccountByChain: Object.fromEntries(upgraded), permissions, positions };
      }), read),

    tool("linked_wallet_request_permission", "Ask the user for a permission on the linked wallet. The user sees a card and signs it in the wallet. Request the smallest set that the task needs: exact contract addresses from official sources, exact function signatures, a short duration. For a token approval, the target is the token contract and the function is approve(address,uint256). The result is AWAITING_USER_SIGNATURE: stop and tell the user to sign. Do not send transactions before linked_wallet_overview shows the permission as active.",
      {
        chain: z.enum(delegation.DELEGATION_CHAINS),
        targets: z.array(z.string().regex(/^0x[0-9a-fA-F]{40}$/)).min(1).max(8).describe("Contracts the agent can call"),
        functions: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*\([^()]*\)$/)).min(1).max(12).describe("Function signatures with types only, for example supply(address,uint256,address,uint16)"),
        maxValueWei: z.string().regex(/^[0-9]+$/).optional().describe("Native value limit per call in wei. Default 0."),
        days: z.number().int().min(1).max(30).optional().describe("Days until the permission ends. Default 7."),
        reason: z.string().min(10).describe("One plain sentence for the user: what you will do with it"),
      },
      run(async (a) => {
        for (const t of a.targets) if (!(await evm.hasCode(a.chain, t as `0x${string}`))) throw new Error(`Target ${t} has no contract code on ${CHAINS[a.chain].name}. Check the address against the official source.`);
        const permission = await delegation.proposePermission(ctx.userId, a);
        ctx.onPermission(permission);
        return { status: "AWAITING_USER_SIGNATURE", permission, note: "The user sees a card to sign. Nothing can be sent from the linked wallet until the user signs." };
      })),

    tool("linked_wallet_send_transactions", "Send contract calls from the user's linked wallet through active permissions. The agent wallet pays the gas, so it needs native gas on that chain. Each call must match one active permission (contract, function, value). The calls are simulated first and nothing is sent when the simulation reverts.",
      {
        chain: z.enum(delegation.DELEGATION_CHAINS),
        summary: z.string().min(10),
        sources: z.array(z.string()).min(1),
        usdValue: z.number().min(0).describe("Total USD value moved or put at risk"),
        transactions: z.array(TxShape).min(1).max(12),
      },
      run(async (a) => {
        const linked = await delegation.getLinkedWallet(ctx.userId);
        const wrapped = await delegation.wrapDelegatedTransactions(ctx.userId, a.chain, a.transactions.map(toEvmTx));
        const simulation = await evm.simulate(a.chain, address, wrapped);
        const first = simulation.results[0];
        if (first?.status === "revert") throw new Error(`Simulation: transaction 1 reverts (${first.error}). Nothing was sent. Check the calldata, the balance of the linked wallet and the limits of the permission.`);
        if (simulation.method === "eth_simulateV1") {
          const bad = simulation.results.find((r) => r.status === "revert");
          if (bad) throw new Error(`Simulation: transaction ${bad.index + 1} reverts (${bad.error}). Nothing was sent.`);
        }
        const chainId = CHAINS[a.chain].chainId!;
        return act("evm_transactions", { chain: a.chain, transactions: wrapped, linkedWallet: linked }, {
          venue: CHAINS[a.chain].name, chain: CHAINS[a.chain].name, summary: `From your wallet ${linked}: ${a.summary}`, sources: a.sources, simulation,
          transactions: wrapped.map((t) => ({ ...t, chainId })),
        }, a.usdValue);
      })),

    tool("aave_v4_action", "Supply, borrow, withdraw or repay on Aave v4. The reserve id sets the chain. The agent can act on an Aave v4 chain that this product supports (see agentCanAct in aave_v4_markets). The official Aave API builds the transactions, with the token approval when one is needed. wallet=agent sends them from the agent wallet after a simulation. wallet=linked only returns the transactions for the user's own wallet: request a permission for their contracts and functions, then send them with linked_wallet_send_transactions. Get the reserve id from aave_v4_markets.",
      {
        action: z.enum(["supply", "borrow", "withdraw", "repay"]),
        reserveId: z.string().min(8).describe("Reserve id from aave_v4_markets"),
        amount: z.string().regex(/^\d+(\.\d+)?$/).describe("Whole tokens, for example 12.5. Ignored when max is true."),
        max: z.boolean().optional().describe("Withdraw or repay the full balance"),
        native: z.boolean().optional().describe("Use ETH in place of WETH"),
        wallet: z.enum(["agent", "linked"]).default("agent"),
        usdValue: z.number().min(0).describe("USD value of the amount"),
      },
      run(async (a) => {
        const linked = a.wallet === "linked" ? await delegation.getLinkedWallet(ctx.userId) : null;
        if (a.wallet === "linked" && !linked) throw new Error("The user has no linked wallet.");
        const built = await aaveV4.buildAction({ action: a.action, reserveId: a.reserveId, amount: a.amount, max: a.max, native: a.native, sender: linked ?? address });
        const txs = built.transactions;
        const chain = built.chain.key;
        if (!chain) throw new Error(`This product cannot send transactions on ${built.chain.name} yet. The agent can read Aave v4 there, but cannot act.`);
        if (linked) return { status: "TRANSACTIONS_BUILT", wallet: linked, chain, transactions: txs, note: "Nothing was sent. Each transaction needs an active permission for its contract (`to`) and its function (the first 4 bytes of `data`). Then call linked_wallet_send_transactions with these transactions." };
        const simulation = await evm.simulate(chain as (typeof EVM_CHAINS)[number], address, txs);
        const bad = simulation.results.find((r, i) => r.status === "revert" && (i === 0 || simulation.method === "eth_simulateV1"));
        if (bad) throw new Error(`Simulation: transaction ${bad.index + 1} reverts (${bad.error}). Nothing was sent. Check the balance, the gas and the limits of the reserve.`);
        const summary = `Aave v4 on ${built.chain.name}: ${a.action} ${a.max ? "all" : a.amount}`;
        return act("evm_transactions", { chain, transactions: txs }, {
          venue: "Aave v4", chain: built.chain.name, summary, sources: ["https://api.aave.com/graphql"], simulation,
          transactions: txs.map((t) => ({ ...t, chainId: built.chainId })),
        }, a.usdValue);
      })),

    // ── Act ─────────────────────────────────────────────────────────────────
    tool("hl_open_position", "Open a Hyperliquid perp position from the agent wallet with one IOC order. The wallet must hold USDC on Hyperliquid first (bridge it when needed). The exact coin must come from hl_markets.",
      {
        coin: z.string().describe("Exact coin from hl_markets, for example BTC or xyz:GOLD"),
        side: z.enum(["long", "short"]),
        marginUsd: z.number().positive(),
        leverage: z.number().int().min(1),
        slippageBps: z.number().int().min(1).max(500).optional(),
        guard: z.object({
          triggerDistancePct: z.number().min(0.5).max(50).describe("Act when the mark price is within this percent of the liquidation price"),
          action: z.enum(["full_close", "partial_deleverage"]),
        }).optional().describe("Liquidation guard to register after the fill"),
      },
      run(async (a) => {
        const p = await hl.previewOrder({ coin: a.coin, isLong: a.side === "long", marginUsd: a.marginUsd, leverage: a.leverage, slippageBps: a.slippageBps, builderFeeTenthBps: config().HL_BUILDER_ADDRESS ? config().HL_BUILDER_FEE_TENTH_BPS : 0 });
        const guard = a.guard ? {
          ...a.guard,
          triggerPx: p.estLiquidationPx * (1 + (a.side === "long" ? 1 : -1) * a.guard.triggerDistancePct / 100),
          pricePerMinuteUsd: config().PRICE_GUARD_MINUTE_USD, disclosure: RISK_DISCLOSURE,
        } : null;
        return act("hl_open_position", a, {
          venue: "Hyperliquid", market: p.market.coin, deployer: p.market.dexFullName, assetId: p.market.assetId, side: a.side,
          marginUsd: p.marginUsd, leverage: p.leverage, notionalUsd: p.notionalUsd, size: p.size,
          estEntryPx: p.estEntryPx, limitPx: p.limitPx, slippageBps: p.slippageBps,
          estLiquidationPx: p.estLiquidationPx, distanceToLiquidationPct: p.distanceToLiquidation * 100,
          estFeeUsd: p.estFeeUsd, builderFeeUsd: p.builderFeeUsd, fundingHourlyPct: p.fundingHourly * 100, guard, warnings: p.warnings,
        }, a.marginUsd);
      })),

    tool("hl_close_position", "Close all or part of an open Hyperliquid position with reduce-only IOC orders.",
      { coin: z.string(), fraction: z.number().gt(0).max(1).describe("1 = full close") },
      run(async (a) => {
        const pos = (await hl.getAccount(address)).positions.find((x) => x.coin.toLowerCase() === a.coin.toLowerCase());
        if (!pos) throw new Error(`No open position in ${a.coin}.`);
        return act("hl_close_position", a, { venue: "Hyperliquid", market: pos.coin, currentSize: pos.size, closeSize: Math.abs(pos.size) * a.fraction, markPx: pos.markPx, unrealizedPnl: pos.unrealizedPnl, orderType: "reduce-only IOC" }, 0);
      })),

    tool("aave_supply_borrow", "Supply collateral and borrow on Aave v3 at a target loan-to-value, from the agent wallet. Returns the health factor after the transactions.",
      { chain: z.enum(["ethereum", "arbitrum", "base"]), collateral: z.string().describe("ETH, WETH, WBTC, USDC, ..."), collateralAmount: z.number().positive(), borrow: z.string(), targetLtvPct: z.number().min(1).max(90) },
      run(async (a) => {
        const p = await aave.previewSupplyBorrow({ chain: a.chain, user: address, collateral: a.collateral, collateralAmount: a.collateralAmount, borrow: a.borrow, targetLtv: a.targetLtvPct / 100 });
        return act("aave_supply_borrow", a, { venue: "Aave v3", ...p }, p.collateral.valueUsd);
      })),

    tool("bridge", "Move tokens between chains through Relay, from the agent wallet to the agent wallet (same address) on the destination. Supports Ethereum, Arbitrum, Base, Hyperliquid (HyperCore), HyperEVM, Tempo and Robinhood Chain.",
      { fromChain: z.enum(EVM_CHAINS), toChain: z.enum(CHAIN_KEYS), fromToken: z.string(), toToken: z.string(), amount: z.number().positive() },
      run(async (a) => {
        if (a.toChain === "solana") throw new Error("The agent wallet has no Solana address yet. Bridging to Solana is not supported.");
        const q = await relay.quoteBridge({ ...a, user: address, recipient: address });
        const transactions = q.steps.flatMap((s) => s.transactions.map((t) => {
          const tx = t as { to: string; data: string; value?: string; chainId?: number };
          return { chainId: tx.chainId, to: tx.to, data: tx.data, value: tx.value ?? "0", description: s.description };
        }));
        return act("bridge", a, { venue: "Relay", ...q, transactions }, a.amount);
      })),

    tool("evm_send_transactions", "Send EVM transactions that you built, from the agent wallet: a contract deployment (to = null, data = creation bytecode with constructor arguments) or contract calls. They are simulated first and nothing is sent when the first one reverts. Use a typed tool when one fits. State in `summary` what the transactions do in plain words, in `sources` the doc pages or address books behind every target address and ABI, and in `usdValue` the value they move.",
      {
        chain: z.enum(EVM_CHAINS),
        summary: z.string().min(10),
        sources: z.array(z.string()).min(1),
        usdValue: z.number().min(0).describe("Total USD value moved or put at risk"),
        transactions: z.array(TxShape).min(1).max(12),
      },
      run(async (a) => {
        const txs = a.transactions.map(toEvmTx);
        for (const t of txs) {
          if (t.to && t.data !== "0x" && !(await evm.hasCode(a.chain, t.to))) throw new Error(`Target ${t.to} has no contract code on ${CHAINS[a.chain].name}. Check the address against the official source.`);
        }
        const simulation = await evm.simulate(a.chain, address, txs);
        const first = simulation.results[0];
        if (first?.status === "revert") throw new Error(`Simulation: transaction 1 reverts (${first.error}). Nothing was sent. Fix the calldata or check the wallet balance, gas and allowances.`);
        if (simulation.method === "eth_simulateV1") {
          const bad = simulation.results.find((r) => r.status === "revert");
          if (bad) throw new Error(`Simulation: transaction ${bad.index + 1} reverts (${bad.error}). Nothing was sent.`);
        }
        const chainId = CHAINS[a.chain].chainId!;
        return act("evm_transactions", { chain: a.chain, transactions: txs }, {
          venue: CHAINS[a.chain].name, chain: CHAINS[a.chain].name, summary: a.summary, sources: a.sources, simulation,
          transactions: txs.map((t) => ({ chainId, ...t })),
          warnings: [
            ...simulation.results.filter((r) => r.status === "unverified").map((r) => `Transaction ${r.index + 1} could not be simulated alone. It depends on an earlier transaction.`),
            ...(txs.some((t) => t.to === null) ? ["This deploys a new contract written by the agent. The contract has no audit."] : []),
          ],
        }, a.usdValue);
      })),

    tool("guard_register_aave", "Register a liquidation guard for the agent wallet's Aave position. A watcher checks the health factor every few seconds. When it is below the threshold, the watcher sends `triggerTx` from the agent wallet, exactly as stored. Build and deploy the unwind first (your own flash-loan contract or an Aave adapter call), test it on a fork, and give the transaction that starts it. The trigger transaction is simulated now and must not revert for a reason other than 'position is healthy'.",
      {
        chain: z.enum(["ethereum", "arbitrum", "base"]),
        healthFactorThreshold: z.number().min(1.02).max(3).describe("Default 1.15"),
        triggerTx: TxShape,
        unwindContract: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
        description: z.string().min(20).describe("What the unwind does, step by step, in plain words"),
        forkTestSummary: z.string().min(20).describe("What you tested on a fork and the result"),
      },
      run(async (a) => {
        const tx = toEvmTx(a.triggerTx);
        if (!tx.to || !(await evm.hasCode(a.chain, tx.to))) throw new Error("The trigger target has no contract code. Deploy the unwind contract first.");
        const account = await aave.getAccount(a.chain, address);
        if (account.healthFactor === null) throw new Error("The agent wallet has no Aave debt on this chain. A guard needs a borrow position.");
        return act("guard_create", { venue: "aave", guard: { chain: a.chain, healthFactorThreshold: a.healthFactorThreshold, triggerTx: tx, description: a.description, unwindContract: a.unwindContract ?? null } }, {
          venue: "Liquidation Guard", chain: CHAINS[a.chain].name, summary: a.description, healthFactorNow: account.healthFactor, healthFactorThreshold: a.healthFactorThreshold,
          unwindContract: a.unwindContract ?? tx.to, forkTest: a.forkTestSummary,
          guard: { healthFactorThreshold: a.healthFactorThreshold, action: "run the stored unwind transaction", pricePerMinuteUsd: config().PRICE_GUARD_MINUTE_USD, disclosure: RISK_DISCLOSURE },
        }, 0);
      })),
  ];

  return createSdkMcpServer({ name: SERVER_NAME, version: "0.2.0", tools });
}

export const TOOL_NAMES = [
  "wallet_overview", "rates_compare", "hl_markets", "hl_account", "hl_outcomes", "sol_quote", "bridge_quote", "bridge_status", "aave_account", "aave_v4_markets", "aave_v4_account", "evm_simulate",
  "hl_open_position", "hl_close_position", "aave_supply_borrow", "bridge", "evm_send_transactions", "guard_register_aave", "aave_v4_action",
  "linked_wallet_overview", "linked_wallet_request_permission", "linked_wallet_send_transactions",
];
export const allToolNames = () => TOOL_NAMES.map((t) => `mcp__${SERVER_NAME}__${t}`);
