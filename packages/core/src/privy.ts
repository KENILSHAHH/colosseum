// Sign-in through Privy. Privy authenticates the person (email, social account or external wallet) and
// creates one embedded wallet for each user in the browser. The server never trusts an address from the browser:
// it verifies the Privy access token, then reads the wallets of that user from the Privy API with the app secret.
import { PrivyClient } from "@privy-io/node";
import { createViemAccount } from "@privy-io/node/viem";
import type { Account, Hex } from "viem";
import { config } from "./config";
import { sql } from "./db";

let client: PrivyClient | undefined;

export const privyEnabled = () => !!(config().PRIVY_APP_ID && config().PRIVY_APP_SECRET);

function privy(): PrivyClient {
  const cfg = config();
  if (!cfg.PRIVY_APP_ID || !cfg.PRIVY_APP_SECRET) throw new Error("PRIVY_APP_ID and PRIVY_APP_SECRET are not set on the server.");
  // With a verification key the token check is local. Without one the SDK reads the key from the Privy API.
  client ??= new PrivyClient({ appId: cfg.PRIVY_APP_ID, appSecret: cfg.PRIVY_APP_SECRET, jwtVerificationKey: cfg.PRIVY_VERIFICATION_KEY });
  return client;
}

export type PrivySignIn = { ok: true; userId: string } | { ok: false; status: 401 | 409; error: string };

/**
 * Exchange a Privy access token for the user id of this app.
 * The user id is the lower-case address of the Privy embedded wallet. Withdrawals from the agent wallet go to it.
 * A user who signed in with an external wallet before Privy keeps the old id, so the agent wallet stays the same.
 */
export async function privySignIn(accessToken: string): Promise<PrivySignIn> {
  let did: string;
  try {
    did = (await privy().utils().auth().verifyAccessToken(accessToken)).user_id;
  } catch {
    return { ok: false, status: 401, error: "The Privy token is invalid or expired." };
  }

  const [known] = await sql()<{ id: string }[]>`select id from users where privy_did = ${did}`;
  if (known) return { ok: true, userId: known.id };

  const user = await privy().users()._get(did);
  const wallets = user.linked_accounts.flatMap((a) => (a.type === "wallet" && a.chain_type === "ethereum" ? [{ address: a.address.toLowerCase(), embedded: a.connector_type === "embedded" }] : []));
  const embedded = wallets.find((w) => w.embedded);
  // The browser creates the wallet a moment after the first login. The browser tries again.
  if (!embedded) return { ok: false, status: 409, error: "The wallet is not ready yet." };

  // Privy verified each linked wallet with a signature, so a row with one of these addresses belongs to this person.
  const addresses = wallets.map((w) => w.address);
  const [claimed] = await sql()<{ id: string }[]>`
    update users set privy_did = ${did}, deposit_wallet = coalesce(deposit_wallet, ${embedded.address})
    where id = (select id from users where id in ${sql()(addresses)} and privy_did is null order by (id = ${embedded.address}) asc, created_at asc limit 1)
    returning id`;
  if (claimed) return { ok: true, userId: claimed.id };

  // "on conflict": two parallel first requests create one user. The Privy wallet is stored at once, so the first page load
  // already shows it as the deposit address (the server signer and the wallet id come later from syncDepositWallet).
  await sql()`insert into users (id, privy_did, deposit_wallet) values (${embedded.address}, ${did}, ${embedded.address}) on conflict do nothing`;
  await sql()`update users set deposit_wallet = coalesce(deposit_wallet, ${embedded.address}) where privy_did = ${did}`;
  const [row] = await sql()<{ id: string }[]>`select id from users where privy_did = ${did}`;
  if (!row) return { ok: false, status: 409, error: "The account is not ready yet." };
  return { ok: true, userId: row.id };
}

// ── The deposit wallet: the Privy wallet of the user ─────────────────────────
export interface DepositWallet { address: string | null; walletId: string | null; enabled: boolean; signerId: string | null }

/** Read the Privy wallet of the user from Privy and store it. `enabled` is true after the user added the server signer. */
export async function syncDepositWallet(userId: string): Promise<DepositWallet> {
  const signerId = config().PRIVY_SIGNER_ID ?? null;
  const [u] = await sql()<{ privy_did: string | null }[]>`select privy_did from users where id = ${userId}`;
  if (!u?.privy_did || !privyEnabled()) return { address: null, walletId: null, enabled: false, signerId };
  const user = await privy().users()._get(u.privy_did);
  const w = user.linked_accounts.find((a) => a.type === "wallet" && a.chain_type === "ethereum" && a.connector_type === "embedded");
  if (!w || w.type !== "wallet" || !("delegated" in w)) return { address: null, walletId: null, enabled: false, signerId };
  const d = { address: w.address.toLowerCase(), walletId: w.id ?? null, enabled: !!w.delegated && !!w.id };
  await sql()`update users set deposit_wallet = ${d.address}, privy_wallet_id = ${d.walletId}, deposit_signer = ${d.enabled} where id = ${userId}`;
  return { ...d, signerId };
}

export async function getDepositWallet(userId: string): Promise<DepositWallet> {
  const [u] = await sql()<{ deposit_wallet: string | null; privy_wallet_id: string | null; deposit_signer: boolean }[]>`select deposit_wallet, privy_wallet_id, deposit_signer from users where id = ${userId}`;
  if (!u?.deposit_wallet) return syncDepositWallet(userId);
  return { address: u.deposit_wallet, walletId: u.privy_wallet_id, enabled: u.deposit_signer, signerId: config().PRIVY_SIGNER_ID ?? null };
}

/** An account that signs from the Privy wallet of a user through the server signer. Privy holds the key. */
export function depositAccount(d: { address: string; walletId: string }): Account {
  const key = config().PRIVY_AUTHORIZATION_KEY;
  if (!key) throw new Error("PRIVY_AUTHORIZATION_KEY is not set on the server.");
  return createViemAccount(privy(), { walletId: d.walletId, address: d.address as Hex, authorizationContext: { authorization_private_keys: [key] } }) as unknown as Account;
}

// ── The Solana wallet: the Privy Solana wallet of the user ────────────────────
const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export interface SolanaWallet { address: string; walletId: string; enabled: boolean }

/** Read the Privy Solana wallet of the user from Privy and store it. `enabled` is true after the user added the server signer. */
export async function syncSolanaWallet(userId: string): Promise<SolanaWallet | null> {
  const [u] = await sql()<{ privy_did: string | null }[]>`select privy_did from users where id = ${userId}`;
  if (!u?.privy_did || !privyEnabled()) return null;
  const user = await privy().users()._get(u.privy_did);
  const w = user.linked_accounts.find((a) => a.type === "wallet" && a.chain_type === "solana" && a.connector_type === "embedded") as { id?: string | null; address: string } | undefined;
  if (!w?.id) return null;
  const signerId = config().PRIVY_SIGNER_ID;
  const full = (await privy().wallets().get(w.id)) as unknown as { additional_signers?: { signer_id: string }[] };
  const enabled = !!signerId && !!full.additional_signers?.some((s) => s.signer_id === signerId);
  await sql()`update users set solana_address = ${w.address}, solana_wallet_id = ${w.id}, solana_signer = ${enabled} where id = ${userId}`;
  return { address: w.address, walletId: w.id, enabled };
}

export async function getSolanaWallet(userId: string): Promise<SolanaWallet | null> {
  const [u] = await sql()<{ solana_address: string | null; solana_wallet_id: string | null; solana_signer: boolean }[]>`select solana_address, solana_wallet_id, solana_signer from users where id = ${userId}`;
  if (u?.solana_address && u.solana_wallet_id && u.solana_signer) return { address: u.solana_address, walletId: u.solana_wallet_id, enabled: true };
  return syncSolanaWallet(userId);
}

const authorization = () => {
  const key = config().PRIVY_AUTHORIZATION_KEY;
  if (!key) throw new Error("PRIVY_AUTHORIZATION_KEY is not set on the server.");
  return { authorization_private_keys: [key] };
};

/** Sign a Solana transaction (base64) with the Solana wallet of the user. Returns the signed transaction, base64. */
export async function solanaSign(walletId: string, transaction: string): Promise<string> {
  const r = (await privy().wallets().solana().signTransaction(walletId, { transaction, authorization_context: authorization() } as never)) as unknown as { signed_transaction: string };
  return r.signed_transaction;
}

/** Sign and send a Solana transaction (base64). `sponsor` asks Privy to pay the fee when fee sponsorship is on for the app. */
export async function solanaSignAndSend(walletId: string, transaction: string, sponsor = config().PRIVY_SOLANA_SPONSOR === "true"): Promise<string> {
  const r = (await privy().wallets().solana().signAndSendTransaction(walletId, { transaction, caip2: SOLANA_MAINNET, ...(sponsor ? { sponsor: true } : {}), authorization_context: authorization() } as never)) as unknown as { hash: string };
  return r.hash;
}
