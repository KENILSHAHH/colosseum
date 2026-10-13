// A deposit from a Solana wallet of the user (Phantom, Solflare, Backpack) to the user's own Privy Solana wallet.
// The server builds the unsigned transaction; the browser wallet signs and sends it. The destination is always the user's
// Privy Solana wallet: this route cannot send anywhere else.
import {
  address, appendTransactionMessageInstructions, compileTransaction, createSolanaRpc, createTransactionMessage, getAddressEncoder,
  getBase64EncodedWireTransaction, getProgramDerivedAddress, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, type Address,
} from "@solana/kit";
import { config } from "./config";

const SYSTEM = address("11111111111111111111111111111111");
const TOKEN = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
/** Tokens offered in the deposit window. Mints from https://solana.com and the issuers. */
export const SOLANA_DEPOSIT_TOKENS: Record<string, { mint: string; decimals: number } | null> = {
  SOL: null,
  USDC: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 },
  USDT: { mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", decimals: 6 },
};

const enc = getAddressEncoder();
const u64 = (n: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b; };

async function ataOf(owner: Address, mint: Address) {
  const [pda] = await getProgramDerivedAddress({ programAddress: ATA, seeds: [enc.encode(owner), enc.encode(TOKEN), enc.encode(mint)] });
  return pda;
}

/** Build the unsigned transfer, base64. `from` signs and pays the fee and, for a token, the account rent of the destination when it is new. */
export async function buildSolanaDeposit(args: { from: string; to: string; symbol: string; amount: string }) {
  const token = SOLANA_DEPOSIT_TOKENS[args.symbol];
  if (token === undefined) throw new Error(`Deposits of ${args.symbol} on Solana are not offered.`);
  const from = address(args.from), to = address(args.to);
  const decimals = token?.decimals ?? 9;
  const [whole, frac = ""] = args.amount.split(".");
  const raw = BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
  if (raw <= 0n) throw new Error("Enter an amount above zero.");

  const signer = { address: from, role: 3 as const };
  const ix: { programAddress: Address; accounts: { address: Address; role: 0 | 1 | 2 | 3 }[]; data: Uint8Array }[] = [];
  if (!token) {
    // System program Transfer: index 2, then the lamports.
    ix.push({ programAddress: SYSTEM, accounts: [signer, { address: to, role: 1 as const }], data: new Uint8Array([2, 0, 0, 0, ...u64(raw)]) });
  } else {
    const mint = address(token.mint);
    const [src, dst] = await Promise.all([ataOf(from, mint), ataOf(to, mint)]);
    // Create the destination token account when it does not exist (CreateIdempotent = 1), then TransferChecked (12).
    ix.push({ programAddress: ATA, accounts: [signer, { address: dst, role: 1 as const }, { address: to, role: 0 as const }, { address: mint, role: 0 as const }, { address: SYSTEM, role: 0 as const }, { address: TOKEN, role: 0 as const }], data: new Uint8Array([1]) });
    ix.push({ programAddress: TOKEN, accounts: [{ address: src, role: 1 as const }, { address: mint, role: 0 as const }, { address: dst, role: 1 as const }, signer], data: new Uint8Array([12, ...u64(raw), decimals]) });
  }
  const { value: blockhash } = await createSolanaRpc(config().RPC_SOLANA).getLatestBlockhash().send();
  const message = pipe(createTransactionMessage({ version: 0 }), (m) => setTransactionMessageFeePayer(from, m), (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m), (m) => appendTransactionMessageInstructions(ix as never, m));
  return { transaction: getBase64EncodedWireTransaction(compileTransaction(message)), to: args.to, symbol: args.symbol, amount: args.amount };
}
