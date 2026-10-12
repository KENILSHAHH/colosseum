// The deposit converter. The Privy wallet of a user is the deposit address.
// A loop looks at each deposit wallet. It converts every token that arrived to OUSD on Tempo through LI.FI (jumper.xyz routes).
// The OUSD goes to the agent wallet of the user, where it pays for prompts and funds actions.
import { accountSender, convertToOusd, NeedsGasError, NothingToConvertError, walletAssets, type WalletAsset } from "./adapters/lifi";
import { config } from "./config";
import { sql } from "./db";
import { depositAccount } from "./privy";
import { getOrCreateWallet } from "./wallet";

interface UserRow { id: string; deposit_wallet: string; privy_wallet_id: string }

async function record(userId: string, a: WalletAsset, r: { status: string; hash?: string | null; expectedOusd?: number | null; detail?: string | null }) {
  await sql()`insert into deposits (user_id, chain_id, chain_name, token, symbol, amount, usd, status, hash, expected_ousd, detail)
    values (${userId}, ${a.chainId}, ${a.chainName}, ${a.token}, ${a.symbol}, ${a.amount}, ${a.usd}, ${r.status}, ${r.hash ?? null}, ${r.expectedOusd ?? null}, ${r.detail ?? null})`;
}

/** A token is not tried again for a time after an attempt: a bridge needs time, and a failure must not repeat each minute. */
async function recentlyTried(userId: string, a: WalletAsset): Promise<boolean> {
  const [row] = await sql()`select 1 from deposits where user_id = ${userId} and chain_id = ${a.chainId} and token = ${a.token}
    and ((status = 'converted' and created_at > now() - interval '3 minutes') or (status <> 'converted' and created_at > now() - interval '30 minutes')) limit 1`;
  return !!row;
}

async function sweepUser(u: UserRow) {
  const assets = await walletAssets(u.deposit_wallet, config().DEPOSIT_MIN_USD);
  if (assets.length === 0) return;
  const to = (await getOrCreateWallet(u.id)).address;
  const account = accountSender(depositAccount({ address: u.deposit_wallet, walletId: u.privy_wallet_id }));
  for (const a of assets) {
    if (await recentlyTried(u.id, a)) continue;
    try {
      const r = await convertToOusd(account, { chainId: a.chainId, token: a.token, toAddress: to });
      await record(u.id, a, { status: "converted", hash: r.hash, expectedOusd: r.expectedOusd, detail: r.tool });
      console.log(`deposit converted: ${a.amount} ${a.symbol} on ${a.chainName} -> about ${r.expectedOusd} OUSD for ${u.id} (${r.hash})`);
    } catch (err) {
      if (err instanceof NothingToConvertError) continue;
      const detail = (err instanceof Error ? err.message : String(err)).split("\n")[0]!.slice(0, 300);
      await record(u.id, a, { status: err instanceof NeedsGasError ? "needs_gas" : "failed", detail });
      console.error(`deposit not converted: ${a.symbol} on ${a.chainName} for ${u.id}: ${detail}`);
    }
  }
}

let running = false;
export async function sweepDeposits() {
  if (running) return;
  running = true;
  try {
    const users = await sql()<UserRow[]>`select id, deposit_wallet, privy_wallet_id from users where deposit_signer and deposit_wallet is not null and privy_wallet_id is not null`;
    for (const u of users) await sweepUser(u).catch((err) => console.error(`deposit sweep failed for ${u.id}:`, err instanceof Error ? err.message.split("\n")[0] : err));
  } finally {
    running = false;
  }
}

/** Start the loop. It runs in the API process. It needs the Privy server signer. */
export function startDepositSweeper() {
  const c = config();
  if (!c.PRIVY_SIGNER_ID || !c.PRIVY_AUTHORIZATION_KEY) return false;
  setInterval(() => void sweepDeposits(), c.DEPOSIT_SWEEP_SECONDS * 1000).unref();
  return true;
}

export async function listDeposits(userId: string) {
  const rows = await sql()`select chain_name, symbol, amount, usd, status, hash, expected_ousd, detail, created_at from deposits where user_id = ${userId} order by created_at desc limit 20`;
  return rows.map((r) => ({ chainName: r.chain_name as string, symbol: r.symbol as string, amount: Number(r.amount), usd: r.usd === null ? null : Number(r.usd), status: r.status as string, hash: r.hash as string | null, expectedOusd: r.expected_ousd === null ? null : Number(r.expected_ousd), detail: r.detail as string | null, createdAt: (r.created_at as Date).toISOString() }));
}
