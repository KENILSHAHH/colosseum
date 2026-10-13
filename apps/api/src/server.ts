import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { verifyMessage } from "viem";
import { z } from "zod";
import { Receipt } from "mppx";
import {
  config, ensureUser, executeIntent, getDepositWallet, getIntent, getOrCreateWallet, getPositions, isExpired, listDeposits, listIntents,
  migrate, privyEnabled, sponsorAddress, syncDepositWallet, syncSolanaWallet, getSolanaWallet, walletSender, privySignIn, promptPriceUsd, recordCharge, runChatAgent, sendToRun, signToken, sql, startLlmProxy, transition, updateWalletSettings, verifyToken, withdrawToOwner, type AgentEvent,
} from "@app/core";
import { delegation, jobs, lifi, paybox } from "@app/core";
import { cancelGuard, listGuards } from "@app/core/guards";
import { agentWalletFetch, mpp, mppEnabled, mppRecipient, ousdBalance, TEMPO_CHAIN_ID } from "./mpp";

type Env = { Variables: { userId: string } };
const app = new Hono<Env>();
app.use("*", cors({ origin: (o) => o ?? "*", credentials: true, exposeHeaders: ["WWW-Authenticate", "Payment-Receipt"] }));

app.get("/health", (c) => c.json({ ok: true, mpp: mppEnabled(), privy: privyEnabled(), gasSponsor: sponsorAddress(), model: config().CLAUDE_MODEL }));

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
for (const p of ["/me", "/wallet", "/wallet/*", "/positions", "/chat", "/chat/*", "/intents", "/intents/*", "/guards", "/guards/*", "/billing", "/billing/*", "/permissions", "/permissions/*", "/deposit", "/deposit/*", "/jobs", "/jobs/*", "/paybox", "/paybox/status", "/paybox/start"]) app.use(p, auth);

// ── Account and agent wallet ───────────────────────────────────────────────
app.get("/me", async (c) => {
  const userId = c.get("userId");
  const cfg = config();
  return c.json({
    address: userId,
    wallet: await getOrCreateWallet(userId),
    linkedWallet: await delegation.getLinkedWallet(userId),
    deposit: await getDepositWallet(userId).then(({ address, enabled, signerId }) => ({ address, enabled, signerId })),
    solana: await getSolanaWallet(userId).then((w) => (w ? { address: w.address, enabled: w.enabled } : null)).catch(() => null),
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
  const w = await getOrCreateWallet(userId);
  return c.json(await getPositions(userId, w.address, w.hlAddress));
});

// ── Chat ───────────────────────────────────────────────────────────────────
const ChatBody = z.object({ prompt: z.string().min(1).max(20_000), sessionId: z.string().optional() });

async function* chatEvents(userId: string, body: z.infer<typeof ChatBody>, signal: AbortSignal): AsyncGenerator<AgentEvent> {
  yield* runChatAgent({ userId, prompt: body.prompt, resume: body.sessionId, signal });
}

/** Value moved to OUSD on Tempo when the wallet has none left. It pays for 100 prompts at 0.01 USD. */
const PROMPT_TOP_UP_USD = 1;
const toppingUp = new Map<string, Promise<boolean>>();

/**
 * Convert about 1 USD of a token of the wallet to OUSD on Tempo, then wait until it arrives.
 * A stablecoin is used before another token. Returns false when no token can pay.
 */
function topUpPromptCredit(userId: string, address: string, price: number): Promise<boolean> {
  const running = toppingUp.get(userId);
  if (running) return running;
  const job = (async () => {
    const assets = await lifi.walletAssets(address, PROMPT_TOP_UP_USD * 1.2).catch(() => []);
    const stable = (s: string) => /^(USDC|USDT|DAI|USDC\.e|USDbC)$/i.test(s);
    assets.sort((x, y) => Number(stable(y.symbol)) - Number(stable(x.symbol)) || (y.usd ?? 0) - (x.usd ?? 0));
    const account = await walletSender(userId);
    for (const a of assets) {
      try {
        const r = await lifi.convertToOusd(account, { chainId: a.chainId, token: a.token, toAddress: address, maxUsd: PROMPT_TOP_UP_USD });
        console.log(`prompt credit: ${a.symbol} on ${a.chainName} -> about ${r.expectedOusd} OUSD for ${userId} (${r.hash})`);
        for (let i = 0; i < 30; i++) {
          if (((await ousdBalance(address)) ?? 0) >= price) return true;
          await new Promise((res) => setTimeout(res, 2000));
        }
        return false;
      } catch (err) {
        console.error(`prompt credit: ${a.symbol} on ${a.chainName} did not convert for ${userId}:`, err instanceof Error ? err.message.split("\n")[0] : err);
      }
    }
    return false;
  })().finally(() => toppingUp.delete(userId));
  toppingUp.set(userId, job);
  return job;
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

// A message for the run that is active now. The agent reads it before its next step. It adds no price: the run is one prompt.
app.post("/chat/message", async (c) => {
  const { prompt } = z.object({ prompt: z.string().min(1).max(20_000) }).parse(await c.req.json());
  return sendToRun(c.get("userId"), prompt) ? c.json({ queued: true }, 202) : c.json({ error: "No run is active." }, 409);
});

app.post("/chat", async (c) => {
  const userId = c.get("userId");
  const body = ChatBody.parse(await c.req.json());
  const cfg = config();
  if (!cfg.ANTHROPIC_API_KEY) return c.json({ error: "ANTHROPIC_API_KEY is not set on the server. Add it to .env and restart the API." }, 503);

  // Development mode: no payment. Usage is still measured and priced.
  if (!mppEnabled()) return chatStream(userId, body, c.req.raw.signal, true);

  // The agent wallet pays the paid route. The check below gives a clear message before a payment that cannot succeed.
  const price = promptPriceUsd();
  const wallet = await getOrCreateWallet(userId);
  let balance = await ousdBalance(wallet.address);
  // One wallet pays for prompts and holds the trading funds. When its OUSD is used up, a small amount of another token becomes OUSD.
  if (balance !== null && balance < price && (await topUpPromptCredit(userId, wallet.address, price))) balance = await ousdBalance(wallet.address);
  if (balance !== null && balance < price)
    return c.json({ error: `Your wallet has no funds for this prompt (${price} USD). Deposit a token in the Deposit panel, with a little ETH for gas, then try again.`, code: "insufficient_funds" }, 402);

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

// ── PayBox (World app): each user connects their own account ─────────────────
app.get("/paybox/status", async (c) => c.json(await paybox.payboxStatus(c.get("userId"))));
app.post("/paybox/start", async (c) => {
  if (!paybox.payboxEnabled()) return c.json({ error: "PayBox is not set up on this server." }, 503);
  return c.json({ url: await paybox.startPayboxAuth(c.get("userId")) });
});
app.delete("/paybox", async (c) => {
  await paybox.disconnectPaybox(c.get("userId"));
  return c.json({ connected: false });
});
// PayBox sends the browser back here. The state names the user, so this route needs no session.
app.get("/paybox/callback", async (c) => {
  const code = c.req.query("code"), state = c.req.query("state"), error = c.req.query("error");
  const app = config().PUBLIC_APP_URL;
  if (error || !code || !state) return c.redirect(`${app}/?paybox=${encodeURIComponent(error ?? "missing")}`);
  try {
    await paybox.finishPayboxAuth(code, state);
    return c.redirect(`${app}/?paybox=connected`);
  } catch (err) {
    return c.redirect(`${app}/?paybox=${encodeURIComponent(err instanceof Error ? err.message.slice(0, 120) : "failed")}`);
  }
});

// ── Scheduled jobs ─────────────────────────────────────────────────────────
app.get("/jobs", async (c) => c.json(await jobs.listJobs(c.get("userId"))));
app.delete("/jobs/:id", async (c) => c.json({ cancelled: await jobs.cancelJob(c.req.param("id"), c.get("userId")) }));

// ── Guards and billing ─────────────────────────────────────────────────────
app.get("/guards", async (c) => c.json(await listGuards(c.get("userId"))));
app.delete("/guards/:id", async (c) => c.json({ cancelled: await cancelGuard(c.req.param("id"), c.get("userId")) }));

app.get("/billing", async (c) => {
  const userId = c.get("userId");
  // With payment on, a price that was recorded while payment was off ("dev-unpaid") is not a charge. Nobody paid it.
  const paidOnly = mppEnabled() ? sql()`and reference is distinct from 'dev-unpaid'` : sql()``;
  const charges = await sql()`select kind, amount_usd, reference, detail, created_at from charges where user_id = ${userId} ${paidOnly} order by created_at desc limit 50`;
  const [totals] = await sql()`select coalesce(sum(amount_usd), 0) as charged from charges where user_id = ${userId} ${paidOnly}`;
  const [llm] = await sql()`select coalesce(sum(cost_usd), 0) as cost, coalesce(sum(input_tokens + output_tokens + cache_read + cache_write), 0) as tokens from usage where user_id = ${userId}`;
  const payment = mppEnabled() ? { ousd: await ousdBalance((await getOrCreateWallet(userId)).address), recipient: mppRecipient(), explorer: "https://explore.tempo.xyz" } : null;
  return c.json({ totalChargedUsd: Number(totals?.charged ?? 0), claudeCostUsd: Number(llm?.cost ?? 0), tokens: Number(llm?.tokens ?? 0), charges, payment });
});

// The balance of the one wallet of the user, in USD: tokens on every chain LI.FI reads, plus OUSD on Tempo.
app.get("/billing/balances", async (c) => {
  const { address } = await getOrCreateWallet(c.get("userId"));
  const [assets, ousd] = await Promise.all([lifi.walletAssets(address, 0).catch(() => null), ousdBalance(address)]);
  return c.json({ address, usd: assets === null && ousd === null ? null : (assets ?? []).reduce((s, a) => s + (a.usd ?? 0), 0) + (ousd ?? 0) });
});

// Every token of the agent wallet that can move to OUSD on Tempo. Routes come from LI.FI, the API of jumper.xyz.
app.get("/billing/assets", async (c) => c.json(await lifi.walletAssets((await getOrCreateWallet(c.get("userId"))).address)));

// Convert one token of the agent wallet to OUSD on Tempo. The destination is the same agent wallet.
app.post("/billing/topup", async (c) => {
  const body = z.object({ chainId: z.number().int().positive(), token: z.string().regex(/^0x[0-9a-fA-F]{40}$/) }).parse(await c.req.json());
  const userId = c.get("userId");
  return c.json(await lifi.convertToOusd(await walletSender(userId), { ...body, toAddress: (await getOrCreateWallet(userId)).address }));
});

// ── Deposits ───────────────────────────────────────────────────────────────
// The Privy wallet of the user is the deposit address. The converter moves each token that arrives there to OUSD on Tempo.
// The browser calls this route after the user added the server signer to the Privy wallet.
app.post("/deposit/enable", async (c) => {
  const userId = c.get("userId");
  const [evm, sol] = await Promise.all([syncDepositWallet(userId), syncSolanaWallet(userId).catch(() => null)]);
  return c.json({ address: evm.address, enabled: evm.enabled, signerId: evm.signerId, solana: sol ? { address: sol.address, enabled: sol.enabled } : null });
});
app.get("/deposit/history", async (c) => c.json(await listDeposits(c.get("userId"))));
app.get("/deposit/options", (c) => c.json({ chains: lifi.DEPOSIT_CHAINS, symbols: lifi.DEPOSIT_SYMBOLS }));

// A deposit of trading funds: a plain transfer of a listed token to the agent wallet. The token stays as it is, ready for a position.
app.post("/deposit/transfer", async (c) => {
  const body = z.object({ chainId: z.number().int().refine((n) => (lifi.TRADING_DEPOSIT_CHAINS as readonly number[]).includes(n)), symbol: z.enum(lifi.DEPOSIT_SYMBOLS), amount: z.string().regex(/^\d+(\.\d+)?$/) }).parse(await c.req.json());
  return lifi.depositTransfer({ ...body, toAddress: (await getOrCreateWallet(c.get("userId"))).address }).then((q) => c.json(q), badRequest);
});

// A direct deposit from an own wallet of the user: any listed token to OUSD on Tempo, delivered to the agent wallet. The browser signs.
app.post("/deposit/quote", async (c) => {
  const body = z.object({ chainId: z.number().int().refine((n) => (lifi.DEPOSIT_CHAINS as readonly number[]).includes(n)), symbol: z.enum(lifi.DEPOSIT_SYMBOLS), amount: z.string().regex(/^\d+(\.\d+)?$/), from: Address }).parse(await c.req.json());
  return lifi.depositQuote({ ...body, toAddress: (await getOrCreateWallet(c.get("userId"))).address }).then((q) => c.json(q), badRequest);
});

app.onError((err, c) => {
  if (err instanceof z.ZodError) return c.json({ error: "Invalid request.", issues: err.issues }, 400);
  console.error(err);
  return c.json({ error: err.message }, 500);
});

await migrate();
startLlmProxy();
// The Privy wallet is now the wallet of the user, so the converter that swept it to OUSD stays off.
const sweeper = false;
jobs.startJobRunner();
serve({ fetch: app.fetch, port: config().API_PORT });
console.log(`API on http://localhost:${config().API_PORT}  (MPP ${mppEnabled() ? "on, Tempo mainnet" : "off"}, deposit converter ${sweeper ? "on" : "off"})`);
