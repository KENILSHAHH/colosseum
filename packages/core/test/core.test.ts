import { afterAll, describe, expect, it } from "vitest";
import { estimateLiquidationPx, roundPrice, roundSize, type HlPosition } from "../src/adapters/hyperliquid";
import { claudeCostUsd, promptPriceUsd } from "../src/billing/pricing";
import { sha256Hex, signToken, stableStringify, verifyToken, encrypt, decrypt } from "../src/crypto";
import { ensureUser, migrate, sql } from "../src/db";
import { claimFiring, createGuard, evaluateHlGuard, normalizeHlParams, superviseDecision } from "../src/guards";
import { createIntent, transition } from "../src/intents";

process.env.KEY_ENCRYPTION_SECRET ??= "test-secret";

const position = (over: Partial<HlPosition>): HlPosition => ({
  coin: "xyz:GOLD", dex: "xyz", size: 0.5, entryPx: 4000, markPx: 4000, liquidationPx: 3300, distanceToLiquidation: 0.175,
  leverage: 5, leverageType: "cross", marginUsed: 400, unrealizedPnl: 0, positionValue: 2000, ...over,
});

describe("hyperliquid order math", () => {
  it("rounds prices to 5 significant figures and the decimal limit", () => {
    expect(roundPrice(4216.4321, 4)).toBe("4216.4");
    expect(roundPrice(0.00123456, 0)).toBe("0.001235");
    expect(roundPrice(109_876.5, 5)).toBe("109880");
  });
  it("rounds sizes down", () => {
    expect(roundSize(0.59599, 4)).toBe("0.5959");
  });
  it("puts a long liquidation price below entry and a short one above", () => {
    const long = estimateLiquidationPx({ entryPx: 4000, leverage: 5, maxLeverage: 25, isLong: true });
    const short = estimateLiquidationPx({ entryPx: 4000, leverage: 5, maxLeverage: 25, isLong: false });
    expect(long).toBeLessThan(4000);
    expect(short).toBeGreaterThan(4000);
    // 5x with 2% maintenance: (4000/5 - 80) / (1 - 0.02) = 734.69 below entry.
    expect(long).toBeCloseTo(4000 - 734.69, 1);
  });
});

describe("guard trigger", () => {
  const params = normalizeHlParams({ coin: "xyz:GOLD", triggerDistancePct: 5, action: "partial_deleverage" });
  it("always allows a full close as the last resort", () => {
    expect(params.allowedActions).toEqual(["partial_deleverage", "full_close"]);
  });
  it("is safe above the trigger distance", () => {
    expect(evaluateHlGuard(params, position({})).state).toBe("safe");
  });
  it("triggers at or below the trigger distance", () => {
    expect(evaluateHlGuard(params, position({ markPx: 3450, distanceToLiquidation: 0.0435 })).state).toBe("triggered");
  });
  it("reports a closed position", () => {
    expect(evaluateHlGuard(params, undefined).state).toBe("closed");
    expect(evaluateHlGuard(params, position({ size: 0 })).state).toBe("closed");
  });
  it("uses the default action when Claude is not available", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const d = await superviseDecision(params, position({}));
    expect(d).toMatchObject({ action: "partial_deleverage", source: "default" });
    if (saved) process.env.ANTHROPIC_API_KEY = saved;
  });
});

describe("pricing", () => {
  it("measures the Claude cost of a prompt", () => {
    const cost = claudeCostUsd("claude-opus-5-5", { inputTokens: 10_000, outputTokens: 2_000, cacheReadInputTokens: 50_000, cacheCreationInputTokens: 0 });
    expect(cost).toBeCloseTo(0.04 + 0.04 + 0.02, 6);
  });
  it("charges one flat price for a prompt", () => {
    expect(promptPriceUsd()).toBe(0.01);
  });
  it("prices an unknown model at the highest rate", () => {
    const u = { inputTokens: 1_000_000, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
    expect(claudeCostUsd("some-new-model", u)).toBe(10);
  });
});

describe("crypto", () => {
  it("hashes the same intent the same way for any key order", () => {
    expect(sha256Hex(stableStringify({ a: 1, b: { d: 2, c: 3 } }))).toBe(sha256Hex(stableStringify({ b: { c: 3, d: 2 }, a: 1 })));
  });
  it("rejects a changed token and an expired token", () => {
    const t = signToken({ sub: "0xabc" }, 60);
    expect(verifyToken(t)?.sub).toBe("0xabc");
    expect(verifyToken(t.replace(/.$/, (c) => (c === "A" ? "B" : "A")))).toBeNull();
    expect(verifyToken(signToken({ sub: "0xabc" }, -1))).toBeNull();
  });
  it("encrypts and decrypts an agent key", () => {
    expect(decrypt(encrypt("0xsecret"))).toBe("0xsecret");
    expect(encrypt("0xsecret")).not.toContain("secret");
  });
});

describe("database guarantees", () => {
  const user = `0xtest${Date.now().toString(16)}`;
  afterAll(async () => {
    await sql()`delete from guard_actions where guard_id in (select id from guards where user_id = ${user})`;
    await sql()`delete from guards where user_id = ${user}`;
    await sql()`delete from intents where user_id = ${user}`;
    await sql()`delete from users where id = ${user}`;
    await sql().end();
  });

  it("lets exactly one of two watchers claim a firing", async () => {
    await migrate();
    await ensureUser(user);
    const guard = await createGuard(user, "hyperliquid", normalizeHlParams({ coin: "xyz:GOLD", triggerDistancePct: 5, action: "full_close" }));
    const claims = await Promise.all([claimFiring(guard, "watcher-a"), claimFiring(guard, "watcher-b")]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it("executes a confirmed intent once when confirm arrives twice", async () => {
    const intent = await createIntent({ userId: user, kind: "hl_close_position", params: { coin: "BTC", fraction: 1 }, preview: {} });
    const results = await Promise.all([
      transition(intent.id, user, "pending", "executing"),
      transition(intent.id, user, "pending", "executing"),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("does not let another user touch an intent", async () => {
    const intent = await createIntent({ userId: user, kind: "hl_close_position", params: { coin: "ETH", fraction: 1 }, preview: {} });
    expect(await transition(intent.id, "0xsomeoneelse", "pending", "executing")).toBeNull();
  });
});
