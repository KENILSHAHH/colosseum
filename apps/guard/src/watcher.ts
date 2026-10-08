// Liquidation Guard watcher. Run two copies with different WATCHER_ID values.
// Both copies evaluate every guard. The atomic claim in the database lets exactly one copy act.
import { hostname } from "node:os";
import { config, getOrCreateWallet, hyperliquid, migrate, recordCharge, sql } from "@app/core";
import {
  claimFiring, evaluateAaveGuard, evaluateHlGuard, executeAaveGuard, executeHlGuardAction, finishFiring, listGuards, recordCheck, superviseDecision,
  type AaveGuardParams, type Guard, type HlGuardParams,
} from "@app/core/guards";

const WATCHER = process.env.WATCHER_ID ?? `${hostname()}-${process.pid}`;
const INTERVAL_MS = Number(process.env.GUARD_INTERVAL_MS ?? 1_000);

async function checkHlGuard(guard: Guard) {
  const params = guard.params as HlGuardParams;
  const market = await hyperliquid.getMarket(params.coin);
  const { address } = await getOrCreateWallet(guard.userId);
  const account = await hyperliquid.getAccount(address, [market.dex]);
  const position = account.positions.find((p) => p.coin === market.coin);
  const verdict = evaluateHlGuard(params, position);
  await recordCheck(guard.id, verdict.distancePct);

  if (verdict.state === "closed") {
    await sql()`update guards set status = 'done' where id = ${guard.id} and status = 'active'`;
    return;
  }
  if (verdict.state !== "triggered" || !position) return;

  const key = await claimFiring(guard, WATCHER);
  if (!key) return; // The other watcher has the claim.
  console.log(`[${WATCHER}] guard ${guard.id} triggered: ${params.coin} is ${verdict.distancePct?.toFixed(2)}% from liquidation`);

  const decision = await superviseDecision(params, position);
  try {
    const { result, rearm } = await executeHlGuardAction(guard, decision.action);
    await finishFiring(key, guard, { ok: true, decision, result, rearm });
    console.log(`[${WATCHER}] guard ${guard.id} ${decision.action} (${decision.source}) done`);
  } catch (err) {
    await finishFiring(key, guard, { ok: false, decision, result: { error: String(err) }, rearm: true });
    console.error(`[${WATCHER}] guard ${guard.id} action failed:`, err);
  }
}

// Aave health factors change per block. One read every few seconds per guard is enough on L2 block times.
const AAVE_EVERY_N_TICKS = Number(process.env.GUARD_AAVE_EVERY_N_TICKS ?? 4);
let tickCount = 0;

async function checkAaveGuard(guard: Guard) {
  const params = guard.params as AaveGuardParams;
  const verdict = await evaluateAaveGuard(guard);
  await recordCheck(guard.id, verdict.healthFactor);
  if (verdict.state === "closed") {
    await sql()`update guards set status = 'done' where id = ${guard.id} and status = 'active'`;
    return;
  }
  if (verdict.state !== "triggered") return;

  const key = await claimFiring(guard, WATCHER);
  if (!key) return;
  console.log(`[${WATCHER}] guard ${guard.id} triggered: Aave health factor ${verdict.healthFactor?.toFixed(3)} < ${params.healthFactorThreshold}`);
  const decision = { action: "stored_unwind_transaction", source: "default" };
  try {
    const result = await executeAaveGuard(guard);
    // A full unwind leaves no debt. A partial one re-arms the guard.
    await finishFiring(key, guard, { ok: true, decision, result, rearm: (result.debtUsdAfter ?? 0) > 1 });
    console.log(`[${WATCHER}] guard ${guard.id} unwind sent: ${result.sent.map((s) => s.hash).join(", ")}`);
  } catch (err) {
    await finishFiring(key, guard, { ok: false, decision, result: { error: String(err) }, rearm: true });
    console.error(`[${WATCHER}] guard ${guard.id} unwind failed:`, err);
  }
}

/** Metered billing: one charge row per watched minute. */
async function bill(guards: Guard[]) {
  const price = config().PRICE_GUARD_MINUTE_USD;
  for (const g of guards) {
    const rows = await sql()`update guards set charged_until = charged_until + interval '1 minute'
      where id = ${g.id} and status = 'active' and charged_until <= now() returning id`;
    if (rows.length) await recordCharge({ userId: g.userId, kind: "guard", amountUsd: price, detail: { guardId: g.id, watcher: WATCHER } });
  }
}

async function tick() {
  const guards = await listGuards(undefined, "active");
  const aaveTurn = tickCount++ % AAVE_EVERY_N_TICKS === 0;
  await Promise.allSettled(
    guards.map((g) => (g.venue === "hyperliquid" ? checkHlGuard(g) : aaveTurn ? checkAaveGuard(g) : Promise.resolve())).map((p, i) =>
      p.catch((err) => console.error(`[${WATCHER}] check failed for guard ${guards[i]?.id}:`, err instanceof Error ? err.message : err)),
    ),
  );
  await bill(guards);
}

await migrate();
console.log(`[${WATCHER}] guard watcher started, interval ${INTERVAL_MS} ms`);
for (;;) {
  const started = Date.now();
  await tick().catch((err) => console.error(`[${WATCHER}] tick failed:`, err));
  await new Promise((r) => setTimeout(r, Math.max(0, INTERVAL_MS - (Date.now() - started))));
}
