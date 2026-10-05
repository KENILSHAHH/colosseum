import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { verifyMessage } from "viem";
import { z } from "zod";
import { Receipt } from "mppx";
import {
  checkBudget, config, ensureUser, executeIntent, getIntent, getOrCreateWallet, getPositions, isExpired, listIntents,
  migrate, privyEnabled, privySignIn, promptPriceUsd, recordCharge, runChatAgent, signToken, sql, startLlmProxy, transition, updateWalletSettings, verifyToken, withdrawToOwner, type AgentEvent,
} from "@app/core";
import { delegation, lifi } from "@app/core";
import { cancelGuard, listGuards } from "@app/core/guards";
import { agentWalletFetch, mpp, mppEnabled, mppRecipient, ousdBalance, TEMPO_CHAIN_ID } from "./mpp";

type Env = { Variables: { userId: string } };
const app = new Hono<Env>();
app.use("*", cors({ origin: (o) => o ?? "*", credentials: true, exposeHeaders: ["WWW-Authenticate", "Payment-Receipt"] }));

app.get("/health", (c) => c.json({ ok: true, mpp: mppEnabled(), privy: privyEnabled(), model: config().CLAUDE_MODEL }));

// ── Sign-in through Privy ───────────────────────────────────────────────────
// The browser sends its Privy access token. The server returns the session token of this app.
app.post("/auth/privy", async (c) => {
  if (!privyEnabled()) return c.json({ error: "PRIVY_APP_ID and PRIVY_APP_SECRET are not set on the server. Add them to .env and restart the API." }, 503);
  const { accessToken } = z.object({ accessToken: z.string().min(1).max(4096) }).parse(await c.req.json());
  const result = await privySignIn(accessToken);
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({ token: signToken({ sub: result.userId, aud: "session" }, 7 * 86_400), address: result.userId });
});

// ── Sign-in with a wallet signature. For scripts on a server without Privy. Off when Privy is on. ──
const SIGN_IN_TEXT = (address: string, nonce: string) => `Sign in to the DeFi agent.\n\nAddress: ${address}\nNonce: ${nonce}\n\nThis signature does not move funds.`;

app.post("/auth/nonce", async (c) => {
  if (privyEnabled()) return c.json({ error: "Sign in through Privy." }, 404);
  const { address } = z.object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/) }).parse(await c.req.json());
  const nonce = signToken({ address: address.toLowerCase(), aud: "nonce" }, 300);
  return c.json({ nonce, message: SIGN_IN_TEXT(address.toLowerCase(), nonce) });
});

app.post("/auth/verify", async (c) => {
  if (privyEnabled()) return c.json({ error: "Sign in through Privy." }, 404);
  const body = z.object({ address: z.string(), nonce: z.string(), signature: z.string() }).parse(await c.req.json());
  const address = body.address.toLowerCase();
  const claims = verifyToken<{ address: string; aud: string }>(body.nonce);
  if (!claims || claims.aud !== "nonce" || claims.address !== address) return c.json({ error: "The nonce is invalid or expired." }, 401);
  const valid = await verifyMessage({ address: address as `0x${string}`, message: SIGN_IN_TEXT(address, body.nonce), signature: body.signature as `0x${string}` });
  if (!valid) return c.json({ error: "The signature does not match the address." }, 401);
  await ensureUser(address);
  return c.json({ token: signToken({ sub: address, aud: "session" }, 7 * 86_400), address });
});

const auth = async (c: Context<Env>, next: () => Promise<void>) => {
  const claims = verifyToken<{ sub: string; aud: string }>(c.req.header("authorization")?.replace(/^Bearer /, ""));
  if (!claims || claims.aud !== "session") return c.json({ error: "Sign in first." }, 401);
  c.set("userId", claims.sub);
  await next();
};
for (const p of ["/me", "/wallet", "/wallet/*", "/positions", "/chat", "/intents", "/intents/*", "/guards", "/guards/*", "/billing", "/billing/*", "/permissions", "/permissions/*"]) app.use(p, auth);

// ── Account and agent wallet ───────────────────────────────────────────────
app.get("/me", async (c) => {
  const userId = c.get("userId");
  const cfg = config();
  return c.json({
    address: userId,
    wallet: await getOrCreateWallet(userId),
    linkedWallet: await delegation.getLinkedWallet(userId),
    pricing: { promptUsd: promptPriceUsd(), actionUsd: cfg.PRICE_ACTION_USD, guardMinuteUsd: cfg.PRICE_GUARD_MINUTE_USD },
    mppEnabled: mppEnabled(),
  });
});

app.post("/wallet/settings", async (c) => {
  const body = z.object({ autoExecute: z.boolean().optional(), maxActionUsd: z.number().positive().max(1_000_000).optional() }).parse(await c.req.json());
  return c.json(await updateWalletSettings(c.get("userId"), body));
});

// Funds leave the agent wallet to the sign-in address only. No other destination is possible on this route.
app.post("/wallet/withdraw", async (c) => {
  const body = z.object({ chain: z.enum(["ethereum", "arbitrum", "base"]), asset: z.enum(["USDC", "ETH"]), amount: z.number().positive() }).parse(await c.req.json());
  return c.json(await withdrawToOwner(c.get("userId"), body));
});

// ── The user's own wallet and its permissions (EIP-7702 delegations to the agent wallet) ──
const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
// A wrong signature or a wrong state is the caller's error, not a server error.
const badRequest = (err: unknown) => Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });

app.post("/wallet/link/nonce", async (c) => c.json(delegation.linkChallenge(c.get("userId"), z.object({ address: Address }).parse(await c.req.json()).address)));
app.post("/wallet/link", async (c) => {
  const body = z.object({ address: Address, nonce: z.string(), signature: z.string() }).parse(await c.req.json());
  return delegation.linkWallet(c.get("userId"), body).then((address) => c.json({ address }), badRequest);
});
app.delete("/wallet/link", async (c) => {
  await delegation.unlinkWallet(c.get("userId"));
  return c.json({ address: null });
});

app.get("/permissions", async (c) => c.json(await delegation.listPermissions(c.get("userId"))));
app.get("/permissions/:id", async (c) => delegation.permissionToSign(c.req.param("id"), c.get("userId")).then((r) => c.json(r), badRequest));
app.post("/permissions/:id/grant", async (c) => {
  const { signature } = z.object({ signature: z.string().regex(/^0x[0-9a-fA-F]+$/) }).parse(await c.req.json());
  return delegation.grantPermission(c.req.param("id"), c.get("userId"), signature).then((r) => c.json(r), badRequest);
});
app.delete("/permissions/:id", async (c) => c.json({ removed: await delegation.removePermission(c.req.param("id"), c.get("userId")) }));

app.get("/positions", async (c) => {
  const userId = c.get("userId");
  return c.json(await getPositions(userId, (await getOrCreateWallet(userId)).address));
});

// ── Chat ───────────────────────────────────────────────────────────────────
const ChatBody = z.object({ prompt: z.string().min(1).max(20_000), sessionId: z.string().optional() });

async function* chatEvents(userId: string, body: z.infer<typeof ChatBody>, signal: AbortSignal): AsyncGenerator<AgentEvent> {
  yield* runChatAgent({ userId, prompt: body.prompt, resume: body.sessionId, signal });
}

const SSE_HEADERS = { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" };

/** Run the agent and send its events as a server-sent event stream. `unpaid` records a price that nobody paid. */
function chatStream(userId: string, body: z.infer<typeof ChatBody>, signal: AbortSignal, unpaid: boolean): Response {
  const encoder = new TextEncoder();
  const events = chatEvents(userId, body, signal);
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value: ev } = await events.next();
      if (done) return controller.close();
      if (ev.type === "done" && unpaid) await recordCharge({ userId, kind: "prompt", amountUsd: ev.chargedUsd, reference: "dev-unpaid", detail: { costUsd: ev.costUsd } });
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
    },
    async cancel() {
      await events.return(undefined);
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}

app.post("/chat", async (c) => {
  const userId = c.get("userId");
  const body = ChatBody.parse(await c.req.json());
  const cfg = config();
  if (!cfg.ANTHROPIC_API_KEY) return c.json({ error: "ANTHROPIC_API_KEY is not set on the server. Add it to .env and restart the API." }, 503);
  const budget = await checkBudget(userId);
  if (!budget.ok) return c.json({ error: budget.reason }, 429);

  // Development mode: no payment. Usage is still measured and priced.
  if (!mppEnabled()) return chatStream(userId, body, c.req.raw.signal, true);

  // The agent wallet pays the paid route. The check below gives a clear message before a payment that cannot succeed.
  const price = promptPriceUsd();
  const wallet = await getOrCreateWallet(userId);
  const balance = await ousdBalance(wallet.address);
  if (balance !== null && balance < price)
    return c.json({ error: `A prompt costs ${price} USD. The agent wallet holds ${balance.toFixed(4)} OUSD on Tempo. Add OUSD in the Payments panel, or send OUSD on Tempo to ${wallet.address}.`, code: "insufficient_ousd" }, 402);

  const payFetch = await agentWalletFetch(userId);
  let paid: Response;
  try {
    paid = await payFetch(`http://127.0.0.1:${cfg.API_PORT}/paid/chat`, {
      method: "POST",
      signal: c.req.raw.signal,
      headers: { "content-type": "application/json", "x-session-token": c.req.header("authorization")!.replace(/^Bearer /, "") },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error("MPP payment failed:", err);
    return c.json({ error: `The payment of ${price} USD did not complete: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`, code: "payment_failed" }, 402);
  }
  if (!paid.ok || !paid.body) {
    const detail = await paid.text().catch(() => "");
    console.error("MPP paid route answered", paid.status, detail.slice(0, 500));
    return c.json({ error: paid.status === 402 ? `The payment of ${price} USD was not accepted.` : `The paid route failed (${paid.status}).`, code: "payment_failed" }, paid.status === 402 ? 402 : 502);
  }
  return new Response(paid.body, { headers: SSE_HEADERS });
});

// The paid route. It speaks MPP: no credential gives a 402 challenge, a valid credential gives the chat stream and a receipt.
// "Authorization" carries the payment credential here, so the session token is in "x-session-token".
app.post("/paid/chat", async (c) => {
  if (!mppEnabled()) return c.json({ error: "Payment is off on this server." }, 404);
  const claims = verifyToken<{ sub: string; aud: string }>(c.req.header("x-session-token"));
  if (!claims || claims.aud !== "session") return c.json({ error: "Sign in first." }, 401);
  const userId = claims.sub;
  const request = c.req.raw.clone();
  const body = ChatBody.parse(await c.req.json());
  const budget = await checkBudget(userId);
  if (!budget.ok) return c.json({ error: budget.reason }, 429);

  const price = promptPriceUsd();
  const result = await mpp().charge({ amount: price.toString(), description: "One prompt to the DeFi agent" })(request);
  if (result.status === 402) return result.challenge;
  const response = result.withReceipt(chatStream(userId, body, c.req.raw.signal, false));
  // The receipt reference is the hash of the payment transaction on Tempo.
  const receipt = Receipt.fromResponse(response);
  await recordCharge({ userId, kind: "prompt", amountUsd: price, reference: receipt.reference, detail: { method: receipt.method, chainId: TEMPO_CHAIN_ID } });
  return response;
});

// ── Intents ────────────────────────────────────────────────────────────────
app.get("/intents", async (c) => c.json(await listIntents(c.get("userId"))));

app.post("/intents/:id/reject", async (c) => {
  const done = await transition(c.req.param("id"), c.get("userId"), "pending", "rejected");
  return done ? c.json(done) : c.json({ error: "The intent is not pending." }, 409);
});

app.post("/intents/:id/confirm", async (c) => {
  const userId = c.get("userId");
  const intent = await getIntent(c.req.param("id"), userId);
  if (!intent) return c.json({ error: "Unknown intent." }, 404);
  if (intent.status !== "pending") return c.json({ error: `The intent is ${intent.status}.` }, 409);
  if (isExpired(intent)) {
    await transition(intent.id, userId, "pending", "expired");
    return c.json({ error: "The preview is older than 5 minutes. Ask the agent for a new one." }, 410);
  }

  // The atomic status change makes a second click a no-op.
  const claimed = await transition(intent.id, userId, "pending", "executing");
  if (!claimed) return c.json({ error: "The intent is not pending." }, 409);
  return c.json(await executeIntent(claimed, (await getOrCreateWallet(userId)).address));
});

// ── Guards and billing ─────────────────────────────────────────────────────
app.get("/guards", async (c) => c.json(await listGuards(c.get("userId"))));
app.delete("/guards/:id", async (c) => c.json({ cancelled: await cancelGuard(c.req.param("id"), c.get("userId")) }));

app.get("/billing", async (c) => {
  const userId = c.get("userId");
  const charges = await sql()`select kind, amount_usd, reference, detail, created_at from charges where user_id = ${userId} order by created_at desc limit 50`;
  const [totals] = await sql()`select coalesce(sum(amount_usd), 0) as charged from charges where user_id = ${userId}`;
  const [llm] = await sql()`select coalesce(sum(cost_usd), 0) as cost, coalesce(sum(input_tokens + output_tokens + cache_read + cache_write), 0) as tokens from usage where user_id = ${userId}`;
  const payment = mppEnabled() ? { ousd: await ousdBalance((await getOrCreateWallet(userId)).address), recipient: mppRecipient(), explorer: "https://explore.tempo.xyz" } : null;
  return c.json({ totalChargedUsd: Number(totals?.charged ?? 0), claudeCostUsd: Number(llm?.cost ?? 0), tokens: Number(llm?.tokens ?? 0), charges, payment });
});

// Every token of the agent wallet that can move to OUSD on Tempo. Routes come from LI.FI, the API of jumper.xyz.
app.get("/billing/assets", async (c) => c.json(await lifi.walletAssets((await getOrCreateWallet(c.get("userId"))).address)));

// Convert one token of the agent wallet to OUSD on Tempo. The destination is the same agent wallet.
app.post("/billing/topup", async (c) => {
  const body = z.object({ chainId: z.number().int().positive(), token: z.string().regex(/^0x[0-9a-fA-F]{40}$/) }).parse(await c.req.json());
  return c.json(await lifi.convertToOusd(c.get("userId"), body));
});

app.onError((err, c) => {
  if (err instanceof z.ZodError) return c.json({ error: "Invalid request.", issues: err.issues }, 400);
  console.error(err);
  return c.json({ error: err.message }, 500);
});

await migrate();
startLlmProxy();
serve({ fetch: app.fetch, port: config().API_PORT });
console.log(`API on http://localhost:${config().API_PORT}  (MPP ${mppEnabled() ? "on, Tempo mainnet" : "off"})`);
