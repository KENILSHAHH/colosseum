// PayBox (paybox.sh): a remote MCP server for the World app (world.xyz). Each user connects their own PayBox account with OAuth 2.1
// (authorization code with PKCE). The agent then gets the PayBox tools for that user. Tokens are stored encrypted.
import { createHash, randomBytes } from "node:crypto";
import { config } from "./config";
import { decrypt, encrypt } from "./crypto";
import { sql } from "./db";

const ISSUER = "https://api.paybox.sh";
export const PAYBOX_MCP_URL = "https://api.paybox.sh/mcp?app=world";
const REDIRECT = () => `${config().PUBLIC_APP_URL}/api/paybox/callback`;

export const payboxEnabled = () => !!config().PAYBOX_CLIENT_ID;
const b64url = (b: Buffer) => b.toString("base64url");

/** Start the sign-in: a PKCE pair and a state, stored for ten minutes. Returns the PayBox page to open. */
export async function startPayboxAuth(userId: string): Promise<string> {
  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(16));
  await sql()`insert into paybox_auth (state, user_id, verifier) values (${state}, ${userId}, ${verifier})`;
  const q = new URLSearchParams({
    response_type: "code", client_id: config().PAYBOX_CLIENT_ID!, redirect_uri: REDIRECT(), scope: "mcp offline_access", state,
    code_challenge: b64url(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256", resource: "https://api.paybox.sh/mcp",
  });
  return `${ISSUER}/oauth/authorize?${q}`;
}

async function tokenRequest(body: Record<string, string>) {
  const res = await fetch(`${ISSUER}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: config().PAYBOX_CLIENT_ID!, ...body }) });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !json.access_token) throw new Error(`PayBox sign-in failed: ${json.error_description ?? json.error ?? res.status}`);
  return json;
}

async function store(userId: string, t: { access_token?: string; refresh_token?: string; expires_in?: number }) {
  const expires = new Date(Date.now() + (t.expires_in ?? 3600) * 1000);
  await sql()`insert into paybox_tokens (user_id, access_token, refresh_token, expires_at) values (${userId}, ${encrypt(t.access_token!)}, ${t.refresh_token ? encrypt(t.refresh_token) : null}, ${expires})
    on conflict (user_id) do update set access_token = excluded.access_token, refresh_token = coalesce(excluded.refresh_token, paybox_tokens.refresh_token), expires_at = excluded.expires_at`;
}

/** The PayBox redirect: exchange the code. Returns the user it belongs to. */
export async function finishPayboxAuth(code: string, state: string): Promise<string> {
  const [row] = await sql()<{ user_id: string; verifier: string }[]>`delete from paybox_auth where state = ${state} and created_at > now() - interval '10 minutes' returning user_id, verifier`;
  if (!row) throw new Error("The PayBox sign-in expired. Start it again.");
  await store(row.user_id, await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: REDIRECT(), code_verifier: row.verifier }));
  return row.user_id;
}

/** A valid access token for the user, refreshed when it is about to end. null when the user has not connected PayBox. */
export async function payboxToken(userId: string): Promise<string | null> {
  if (!payboxEnabled()) return null;
  const [row] = await sql()<{ access_token: string; refresh_token: string | null; expires_at: Date }[]>`select access_token, refresh_token, expires_at from paybox_tokens where user_id = ${userId}`;
  if (!row) return null;
  if (row.expires_at.getTime() - Date.now() > 120_000) return decrypt(row.access_token);
  if (!row.refresh_token) return null;
  try {
    await store(userId, await tokenRequest({ grant_type: "refresh_token", refresh_token: decrypt(row.refresh_token) }));
    return payboxToken(userId);
  } catch {
    return null;
  }
}

export async function payboxStatus(userId: string) {
  const [row] = await sql()<{ expires_at: Date; refresh_token: string | null }[]>`select expires_at, refresh_token from paybox_tokens where user_id = ${userId}`;
  return { available: payboxEnabled(), connected: !!row && (!!row.refresh_token || row.expires_at.getTime() > Date.now()) };
}

export async function disconnectPaybox(userId: string) {
  await sql()`delete from paybox_tokens where user_id = ${userId}`;
}
