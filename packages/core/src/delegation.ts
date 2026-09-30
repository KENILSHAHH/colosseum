// Permissions on the user's own wallet (the "linked wallet"). EIP-7702 and the MetaMask Delegation Framework.
// Docs: https://docs.metamask.io/smart-accounts-kit/guides/delegation/execute-on-smart-accounts-behalf/
//
// 1. The user upgrades the wallet to a MetaMask smart account (EIP-7702). The address stays the same.
// 2. The user signs a delegation to the agent wallet. It names the contracts, the functions, a native value limit and an end date.
// 3. The agent wallet sends `redeemDelegations` to the DelegationManager. The user's wallet then makes the call itself.
// A call outside the signed limits reverts on-chain. The server never holds the key of the linked wallet.
import { randomBytes } from "node:crypto";
import { createDelegation, createExecution, ExecutionMode, getSmartAccountsEnvironment, ScopeType } from "@metamask/smart-accounts-kit";
import { DelegationManager } from "@metamask/smart-accounts-kit/contracts";
import { SIGNABLE_DELEGATION_TYPED_DATA } from "@metamask/smart-accounts-kit/utils";
import { recoverMessageAddress, recoverTypedDataAddress, toFunctionSelector, type Address, type Hex } from "viem";
import type { EvmTx } from "./adapters/evm";
import { signToken, verifyToken } from "./crypto";
import { sql } from "./db";
import { CHAINS, type ChainKey } from "./registry/chains";
import { getOrCreateWallet, publicClient } from "./wallet";

/** Chains with the delegation contracts and with a wallet that can do the EIP-7702 upgrade. */
export const DELEGATION_CHAINS = ["ethereum", "arbitrum", "base"] as const;
export type DelegationChain = (typeof DELEGATION_CHAINS)[number];
const MAX_DAYS = 30;
/** Functions that can move tokens out of the wallet. The user sees a warning for each one. */
const RISKY = /^(approve|transfer|transferFrom|setApprovalForAll|permit|increaseAllowance|safeTransferFrom|multicall|execute)\(/;

const environment = (chain: DelegationChain) => getSmartAccountsEnvironment(CHAINS[chain].chainId!);
const manager = (chain: DelegationChain) => environment(chain).DelegationManager as Address;

interface Row {
  id: string; user_id: string; owner: string; chain: DelegationChain; targets: string[]; selectors: string[]; max_value_wei: string;
  expires_at: Date; reason: string; delegation: StoredDelegation; signature: string | null; status: string; created_at: Date;
}
interface StoredDelegation { delegate: Address; delegator: Address; authority: Hex; caveats: { enforcer: Address; terms: Hex; args: Hex }[]; salt: Hex }

export interface Permission {
  id: string; owner: string; chain: DelegationChain; chainId: number; chainName: string;
  targets: string[]; functions: string[]; maxValueWei: string; expiresAt: string; reason: string;
  status: "pending" | "active" | "rejected" | "removed"; warnings: string[]; createdAt: string;
}

const view = (r: Row): Permission => ({
  id: r.id, owner: r.owner, chain: r.chain, chainId: CHAINS[r.chain].chainId!, chainName: CHAINS[r.chain].name,
  targets: r.targets, functions: r.selectors, maxValueWei: r.max_value_wei, expiresAt: r.expires_at.toISOString(), reason: r.reason,
  status: (r.status === "active" && r.expires_at.getTime() < Date.now() ? "removed" : r.status) as Permission["status"],
  warnings: [
    ...r.selectors.filter((s) => RISKY.test(s)).map((s) => `"${s}" can move tokens out of your wallet.`),
    ...(BigInt(r.max_value_wei) > 0n ? [`Each call can send up to ${Number(BigInt(r.max_value_wei)) / 1e18} of the native token.`] : []),
  ],
  createdAt: r.created_at.toISOString(),
});

// ── Link the wallet ──────────────────────────────────────────────────────────
const LINK_TEXT = (address: string, nonce: string) => `Link this wallet to your DeFi agent account.\n\nWallet: ${address}\nNonce: ${nonce}\n\nThis signature does not move funds and gives no permission.`;

export function linkChallenge(userId: string, address: string) {
  const a = address.toLowerCase();
  const nonce = signToken({ sub: userId, address: a, aud: "link" }, 600);
  return { nonce, message: LINK_TEXT(a, nonce) };
}

export async function linkWallet(userId: string, args: { address: string; nonce: string; signature: string }): Promise<string> {
  const a = args.address.toLowerCase();
  const claims = verifyToken<{ sub: string; address: string; aud: string }>(args.nonce);
  if (!claims || claims.aud !== "link" || claims.sub !== userId || claims.address !== a) throw new Error("The link request is invalid or expired.");
  const signer = await recoverMessageAddress({ message: LINK_TEXT(a, args.nonce), signature: args.signature as Hex });
  if (signer.toLowerCase() !== a) throw new Error("The signature does not match the wallet.");
  await sql()`update users set linked_wallet = ${a} where id = ${userId}`;
  return a;
}

export async function unlinkWallet(userId: string) {
  await sql()`update delegations set status = 'removed', signature = null where user_id = ${userId} and status in ('pending', 'active')`;
  await sql()`update users set linked_wallet = null where id = ${userId}`;
}

export async function getLinkedWallet(userId: string): Promise<Address | null> {
  const [row] = await sql()<{ linked_wallet: string | null }[]>`select linked_wallet from users where id = ${userId}`;
  return (row?.linked_wallet as Address | undefined) ?? null;
}

/** True when the address runs the MetaMask EIP-7702 account code on this chain. A delegation works only then. */
export async function isUpgraded(chain: DelegationChain, owner: string): Promise<boolean> {
  const code = await publicClient(chain).getCode({ address: owner as Address });
  const impl = (environment(chain).implementations as Record<string, string>).EIP7702StatelessDeleGatorImpl!;
  return code?.toLowerCase() === `0xef0100${impl.slice(2).toLowerCase()}`;
}

// ── Permissions ──────────────────────────────────────────────────────────────
export async function proposePermission(userId: string, args: { chain: DelegationChain; targets: string[]; functions: string[]; maxValueWei?: string; days?: number; reason: string }): Promise<Permission> {
  const owner = await getLinkedWallet(userId);
  if (!owner) throw new Error("The user has no linked wallet. Ask the user to link a wallet in the sidebar first.");
  const agent = (await getOrCreateWallet(userId)).address;
  const targets = [...new Set(args.targets.map((t) => t.toLowerCase()))];
  // "supply(address,uint256,address,uint16)": no spaces, no parameter names.
  const functions = [...new Set(args.functions.map((f) => f.replace(/\s+/g, "")))];
  for (const f of functions) toFunctionSelector(f);
  const days = Math.min(Math.max(args.days ?? 7, 1), MAX_DAYS);
  const expires = Math.floor(Date.now() / 1000) + days * 86_400;
  const maxValue = BigInt(args.maxValueWei ?? "0");

  const d = createDelegation({
    from: owner, to: agent, environment: environment(args.chain),
    scope: { type: ScopeType.FunctionCall, targets: targets as Address[], selectors: functions, valueLte: { maxValue } },
    caveats: [{ type: "timestamp", afterThreshold: 0, beforeThreshold: expires }],
  } as never) as unknown as StoredDelegation;
  // A random salt makes each permission a different delegation.
  const delegation: StoredDelegation = { delegate: d.delegate, delegator: d.delegator, authority: d.authority, caveats: d.caveats, salt: `0x${randomBytes(16).toString("hex")}` };

  const id = `perm_${randomBytes(8).toString("hex")}`;
  const [row] = await sql()<Row[]>`
    insert into delegations (id, user_id, owner, chain, targets, selectors, max_value_wei, expires_at, reason, delegation)
    values (${id}, ${userId}, ${owner}, ${args.chain}, ${sql().json(targets)}, ${sql().json(functions)}, ${maxValue.toString()}, ${new Date(expires * 1000)}, ${args.reason}, ${sql().json(delegation as never)})
    returning *`;
  return view(row!);
}

/** The data the wallet signs with `eth_signTypedData_v4`. */
export function typedData(r: Row) {
  return {
    domain: { name: "DelegationManager", version: "1", chainId: CHAINS[r.chain].chainId!, verifyingContract: manager(r.chain) },
    types: { ...SIGNABLE_DELEGATION_TYPED_DATA },
    primaryType: "Delegation" as const,
    message: { delegate: r.delegation.delegate, delegator: r.delegation.delegator, authority: r.delegation.authority, caveats: r.delegation.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms })), salt: BigInt(r.delegation.salt).toString() },
  };
}

const rowOf = async (id: string, userId: string) => (await sql()<Row[]>`select * from delegations where id = ${id} and user_id = ${userId}`)[0];

/** What the browser needs to grant a pending permission. */
export async function permissionToSign(id: string, userId: string) {
  const r = await rowOf(id, userId);
  if (!r) throw new Error("Unknown permission.");
  const t = typedData(r);
  return {
    permission: view(r), upgraded: await isUpgraded(r.chain, r.owner),
    typedData: { ...t, types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }], ...t.types } },
  };
}

export async function grantPermission(id: string, userId: string, signature: string): Promise<Permission> {
  const r = await rowOf(id, userId);
  if (!r || r.status !== "pending") throw new Error("The permission is not pending.");
  const t = typedData(r);
  const signer = await recoverTypedDataAddress({ ...t, message: { ...t.message, salt: BigInt(t.message.salt) }, signature: signature as Hex } as never);
  if (signer.toLowerCase() !== r.owner) throw new Error("The signature is not from the linked wallet.");
  if (!(await isUpgraded(r.chain, r.owner))) throw new Error(`The wallet is not a smart account on ${CHAINS[r.chain].name} yet. Do the upgrade first.`);
  const [row] = await sql()<Row[]>`update delegations set status = 'active', signature = ${signature} where id = ${id} and status = 'pending' returning *`;
  return view(row!);
}

/** Reject a pending permission or remove an active one. The server deletes the signature, so the agent cannot use it again. */
export async function removePermission(id: string, userId: string): Promise<boolean> {
  const rows = await sql()`update delegations set status = case when status = 'pending' then 'rejected' else 'removed' end, signature = null where id = ${id} and user_id = ${userId} and status in ('pending', 'active') returning id`;
  return rows.length > 0;
}

export async function listPermissions(userId: string): Promise<Permission[]> {
  const rows = await sql()<Row[]>`select * from delegations where user_id = ${userId} and status in ('pending', 'active') and expires_at > now() order by created_at desc limit 50`;
  return rows.map(view);
}

// ── Use a permission ─────────────────────────────────────────────────────────
/**
 * Wrap calls of the linked wallet into `redeemDelegations` transactions that the agent wallet sends.
 * Each call needs one active permission that covers its contract, its function and its value.
 */
export async function wrapDelegatedTransactions(userId: string, chain: DelegationChain, txs: EvmTx[]): Promise<EvmTx[]> {
  const owner = await getLinkedWallet(userId);
  if (!owner) throw new Error("The user has no linked wallet.");
  const rows = await sql()<Row[]>`select * from delegations where user_id = ${userId} and owner = ${owner} and chain = ${chain} and status = 'active' and expires_at > now() order by created_at desc`;
  return txs.map((tx, i) => {
    if (!tx.to) throw new Error("A linked wallet cannot deploy a contract through a permission.");
    const selector = tx.data.slice(0, 10).toLowerCase();
    const r = rows.find((p) => p.targets.includes(tx.to!.toLowerCase()) && p.selectors.some((f) => toFunctionSelector(f) === selector) && BigInt(tx.value) <= BigInt(p.max_value_wei));
    if (!r) throw new Error(`No active permission covers transaction ${i + 1}: contract ${tx.to}, function selector ${selector}, value ${tx.value} wei on ${CHAINS[chain].name}. Request it with linked_wallet_request_permission and wait for the user to grant it.`);
    const data = DelegationManager.encode.redeemDelegations({
      delegations: [[{ ...r.delegation, signature: r.signature as Hex }]],
      modes: [ExecutionMode.SingleDefault],
      executions: [[createExecution({ target: tx.to, callData: tx.data, value: BigInt(tx.value) })]],
    } as never);
    return { to: manager(chain), data, value: "0", description: `From your wallet: ${tx.description}` };
  });
}
