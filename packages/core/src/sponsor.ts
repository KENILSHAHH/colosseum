// Gas sponsorship with EIP-7702. Spec: https://eips.ethereum.org/EIPS/eip-7702
//
// One sponsor account sends the transactions of every user and pays the gas. A user wallet needs no native token.
// No money goes to the user wallet, and its address does not change.
//
// 1. The user wallet signs an EIP-7702 authorization one time for each chain. Its code becomes the MetaMask smart account
//    (EIP7702StatelessDeleGator). The sponsor sends that authorization, so the upgrade costs the user nothing.
// 2. The user wallet signs a delegation to the sponsor. This is a signature, not a transaction.
// 3. The sponsor sends `redeemDelegations` to the DelegationManager. The user wallet then makes the calls itself:
//    `msg.sender` is the user wallet, and its balances and positions are the ones that change.
//
// The contracts are the audited MetaMask Delegation Framework deployments from `@metamask/smart-accounts-kit`.
// They were read on Ethereum, Arbitrum, Base and Robinhood Chain on 2026-10-12. HyperEVM has no EIP-7702.
// Tempo has no native gas token, so it stays on its own fee system.
import { randomBytes } from "node:crypto";
import { createExecution, ExecutionMode, getSmartAccountsEnvironment, ROOT_AUTHORITY } from "@metamask/smart-accounts-kit";
import { DelegationManager } from "@metamask/smart-accounts-kit/contracts";
import { SIGNABLE_DELEGATION_TYPED_DATA } from "@metamask/smart-accounts-kit/utils";
import { concat, createWalletClient, getContractAddress, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { EvmTx } from "./adapters/evm";
import { config } from "./config";
import { sql } from "./db";
import { CHAINS, type ChainKey } from "./registry/chains";
import { publicClient, viemChain, walletAccount } from "./wallet";

export const SPONSORED_CHAINS = ["ethereum", "arbitrum", "base", "robinhood"] as const satisfies readonly ChainKey[];
/** Deterministic deployment proxy (CREATE2). A delegated wallet cannot use CREATE through `execute`, so a deployment goes through it. */
const CREATE2_DEPLOYER = "0x4e59b44847b379578588920cA78FbF26c0B4956C" as const;

export const sponsorEnabled = () => !!config().SPONSOR_PRIVATE_KEY;
export const isSponsored = (chain: ChainKey) => sponsorEnabled() && (SPONSORED_CHAINS as readonly string[]).includes(chain);
const sponsor = () => privateKeyToAccount(config().SPONSOR_PRIVATE_KEY as Hex);
export const sponsorAddress = (): Address | null => (sponsorEnabled() ? sponsor().address : null);

/** One sponsor transaction at a time for each chain. Two at the same time would use the same nonce. */
const queues = new Map<string, Promise<unknown>>();
function inOrder<T>(chain: string, job: () => Promise<T>): Promise<T> {
  const next = (queues.get(chain) ?? Promise.resolve()).then(job, job);
  queues.set(chain, next.catch(() => undefined));
  return next;
}

/**
 * A public RPC sometimes answers a read with a node error just after a new block ("archive request", "header not found").
 * That is not a revert. The read is tried again. A revert is not tried again.
 */
async function withRetry<T>(read: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await read();
    } catch (err) {
      const text = err instanceof Error ? `${err.message} ${(err as { details?: string }).details ?? ""}` : String(err);
      if (i >= attempts || /revert/i.test(text) || !/archive|header not found|missing trie node|timeout|rate limit|429|50\d/i.test(text)) throw err;
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
}

export interface SponsoredResult { hash: Hex; block: number; gasUsed: string; deployed: (Address | null)[] }

/**
 * Run calls from the wallet of the user in one transaction that the sponsor sends and pays for. All calls succeed or none does.
 * A call with `to: null` deploys a contract through the CREATE2 proxy. Its constructor sees the proxy as `msg.sender`.
 */
export async function sendSponsored(userId: string, chain: ChainKey, txs: EvmTx[]): Promise<SponsoredResult> {
  if (!isSponsored(chain)) throw new Error(`Gas sponsorship is not available on ${CHAINS[chain].name}.`);
  const limit = config().SPONSOR_DAILY_TXS;
  const [used] = await sql()<{ n: string }[]>`select count(*) as n from sponsored_txs where user_id = ${userId} and created_at > now() - interval '24 hours'`;
  if (Number(used?.n ?? 0) >= limit) throw new Error(`The daily limit of ${limit} sponsored transactions is reached. Try again tomorrow.`);

  const owner = await walletAccount(userId);
  const chainId = CHAINS[chain].chainId!;
  const env = getSmartAccountsEnvironment(chainId);
  const manager = env.DelegationManager as Address;
  const implementation = (env.implementations as Record<string, string>).EIP7702StatelessDeleGatorImpl as Address;
  const reader = publicClient(chain);
  const relayer = createWalletClient({ account: sponsor(), chain: viemChain(chain), transport: http() });

  // A deployment becomes a call to the CREATE2 proxy: 32 bytes of salt, then the creation code.
  const deployed: (Address | null)[] = [];
  const executions = txs.map((t) => {
    if (t.to) {
      deployed.push(null);
      return createExecution({ target: t.to, callData: t.data, value: BigInt(t.value) });
    }
    const salt = `0x${randomBytes(32).toString("hex")}` as Hex;
    deployed.push(getContractAddress({ opcode: "CREATE2", from: CREATE2_DEPLOYER, salt, bytecode: t.data }));
    return createExecution({ target: CREATE2_DEPLOYER, callData: concat([salt, t.data]), value: BigInt(t.value) });
  });

  // The delegation gives the sponsor, and only the sponsor, the right to make the wallet execute calls. The server holds both keys.
  const delegation = { delegate: relayer.account.address, delegator: owner.address, authority: ROOT_AUTHORITY as Hex, caveats: [] as { enforcer: Address; terms: Hex; args: Hex }[], salt: "0x00" as Hex };
  const signature = await owner.signTypedData({
    domain: { name: "DelegationManager", version: "1", chainId, verifyingContract: manager },
    types: SIGNABLE_DELEGATION_TYPED_DATA,
    primaryType: "Delegation",
    message: { delegate: delegation.delegate, delegator: delegation.delegator, authority: delegation.authority, caveats: [], salt: 0n },
  } as never);
  const data = DelegationManager.encode.redeemDelegations({
    delegations: [[{ ...delegation, signature }]],
    modes: [executions.length === 1 ? ExecutionMode.SingleDefault : ExecutionMode.BatchDefault],
    executions: [executions],
  } as never);

  return inOrder(chain, async () => {
    const [code, balance] = await Promise.all([reader.getCode({ address: owner.address }), reader.getBalance({ address: relayer.account.address })]);
    if (balance === 0n) throw new Error(`The gas sponsor ${relayer.account.address} has no ETH on ${CHAINS[chain].name}. The operator must fund it.`);
    if (code?.toLowerCase() !== `0xef0100${implementation.slice(2).toLowerCase()}`) {
      // First use on this chain: the wallet signs the EIP-7702 authorization and the sponsor sends it.
      const authorization = await createWalletClient({ account: owner, chain: viemChain(chain), transport: http() }).signAuthorization({ contractAddress: implementation });
      const h = await relayer.sendTransaction({ authorizationList: [authorization], to: owner.address, data: "0x" });
      const r = await reader.waitForTransactionReceipt({ hash: h, timeout: 120_000 });
      if (r.status !== "success") throw new Error(`The wallet upgrade ${h} reverted.`);
    }
    // A dry run finds a failing call before the sponsor pays for it.
    const gas = await withRetry(() => reader.estimateGas({ account: relayer.account, to: manager, data }));
    const hash = await relayer.sendTransaction({ to: manager, data, gas: (gas * 13n) / 10n });
    const receipt = await reader.waitForTransactionReceipt({ hash, timeout: 180_000 });
    await sql()`insert into sponsored_txs (user_id, chain, hash, gas_cost_wei, success) values (${userId}, ${chain}, ${hash}, ${(receipt.gasUsed * receipt.effectiveGasPrice).toString()}, ${receipt.status === "success"})`;
    if (receipt.status !== "success") throw new Error(`The sponsored transaction ${hash} reverted. Nothing changed.`);
    return { hash, block: Number(receipt.blockNumber), gasUsed: receipt.gasUsed.toString(), deployed };
  });
}
