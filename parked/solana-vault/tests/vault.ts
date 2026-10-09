import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { createMint, getAccount, getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, mintTo, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import { assert } from "chai";
import { createHash } from "crypto";
import { Vault } from "../target/types/vault";

const USD = (n: number) => new BN(Math.round(n * 1e6));
const sha = (s: string) => [...createHash("sha256").update(s).digest()];
const CHAIN = { ethereum: 0, arbitrum: 1, base: 2, hyperliquid: 6, solana: 7 };
const PROTOCOL = { aave: 0, hyperliquid: 1, jupiter: 2 };
const bits = (...positions: number[]) => positions.reduce((m, p) => m | (1 << p), 0);

describe("vault", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.vault as Program<Vault>;
  const owner = provider.wallet as anchor.Wallet;
  const agent = Keypair.generate();
  const stranger = Keypair.generate();
  const feeRecipient = Keypair.generate();
  const [policy] = PublicKey.findProgramAddressSync([Buffer.from("policy"), owner.publicKey.toBuffer()], program.programId);
  const logPda = (seq: number) => PublicKey.findProgramAddressSync([Buffer.from("log"), owner.publicKey.toBuffer(), new BN(seq).toArrayLike(Buffer, "le", 8)], program.programId)[0];
  const jobPda = (id: number) => PublicKey.findProgramAddressSync([Buffer.from("job"), owner.publicKey.toBuffer(), new BN(id).toArrayLike(Buffer, "le", 8)], program.programId)[0];

  const policyArgs = (over: Partial<Record<string, unknown>> = {}) => ({
    agent: agent.publicKey,
    maxTradeUsd: USD(1_000),
    dailyLimitUsd: USD(2_500),
    allowedChains: bits(CHAIN.arbitrum, CHAIN.hyperliquid, CHAIN.solana),
    allowedProtocols: new BN(bits(PROTOCOL.aave, PROTOCOL.hyperliquid, PROTOCOL.jupiter)),
    spendRecipients: [feeRecipient.publicKey, PublicKey.default, PublicKey.default, PublicKey.default],
    ...over,
  });

  const authorize = (signer: Keypair, seq: number, chain: number, protocol: number, usd: number) =>
    program.methods
      .authorizeAction(sha(`intent-${seq}`), chain, protocol, USD(usd))
      .accounts({ agent: signer.publicKey, policy, actionLog: logPda(seq), systemProgram: SystemProgram.programId } as any)
      .signers([signer])
      .rpc();

  const expectError = async (p: Promise<unknown>, code: string) => {
    try {
      await p;
    } catch (e: any) {
      assert.include(e.toString(), code);
      return;
    }
    assert.fail(`expected error ${code}`);
  };

  before(async () => {
    for (const kp of [agent, stranger]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
    }
  });

  it("creates a policy", async () => {
    await program.methods.initializePolicy(policyArgs() as any).accounts({ owner: owner.publicKey } as any).rpc();
    const p = await program.account.policy.fetch(policy);
    assert.ok(p.owner.equals(owner.publicKey));
    assert.ok(p.agent.equals(agent.publicKey));
    assert.equal(p.revoked, false);
  });

  it("authorizes an action inside the policy and writes a log entry", async () => {
    await authorize(agent, 0, CHAIN.hyperliquid, PROTOCOL.hyperliquid, 500);
    const log = await program.account.actionLog.fetch(logPda(0));
    assert.equal(log.status, 0);
    assert.deepEqual(log.intentHash, sha("intent-0"));
    assert.equal((await program.account.policy.fetch(policy)).spentTodayUsd.toNumber(), 500e6);
  });

  it("stores the destination transaction id", async () => {
    await program.methods.finalizeAction(new BN(0), true, "oid:123456789").accounts({ agent: agent.publicKey, policy, actionLog: logPda(0) } as any).signers([agent]).rpc();
    const log = await program.account.actionLog.fetch(logPda(0));
    assert.equal(log.status, 1);
    assert.equal(log.txRef, "oid:123456789");
    await expectError(
      program.methods.finalizeAction(new BN(0), true, "again").accounts({ agent: agent.publicKey, policy, actionLog: logPda(0) } as any).signers([agent]).rpc(),
      "AlreadyFinalized",
    );
  });

  it("rejects a signer that is not the agent", async () => {
    await expectError(authorize(stranger, 1, CHAIN.hyperliquid, PROTOCOL.hyperliquid, 10), "NotAgent");
  });

  it("rejects a trade above the trade limit", async () => {
    await expectError(authorize(agent, 1, CHAIN.hyperliquid, PROTOCOL.hyperliquid, 1_001), "TradeTooLarge");
  });

  it("rejects a chain and a protocol that are not allowed", async () => {
    await expectError(authorize(agent, 1, CHAIN.ethereum, PROTOCOL.aave, 10), "ChainNotAllowed");
    await expectError(authorize(agent, 1, CHAIN.arbitrum, 9, 10), "ProtocolNotAllowed");
  });

  it("enforces the daily limit and refunds a failed action", async () => {
    await authorize(agent, 1, CHAIN.arbitrum, PROTOCOL.aave, 1_000);
    await authorize(agent, 2, CHAIN.arbitrum, PROTOCOL.aave, 1_000);
    // 500 + 1000 + 1000 = 2500 = the limit. One more dollar fails.
    await expectError(authorize(agent, 3, CHAIN.arbitrum, PROTOCOL.aave, 1), "DailyLimitExceeded");
    await program.methods.finalizeAction(new BN(2), false, "").accounts({ agent: agent.publicKey, policy, actionLog: logPda(2) } as any).signers([agent]).rpc();
    assert.equal((await program.account.policy.fetch(policy)).spentTodayUsd.toNumber(), 1_500e6);
    await authorize(agent, 3, CHAIN.arbitrum, PROTOCOL.aave, 1_000);
  });

  it("registers a watch job from the agent and lets the owner cancel it", async () => {
    const args = { venue: 1, assetHash: sha("xyz:GOLD"), triggerKind: 0, triggerValue: new BN(500), action: 0, maxSlippageBps: 100, gasBudgetUsd: USD(5) };
    await program.methods.registerWatchJob(new BN(1), args as any).accounts({ authority: agent.publicKey, policy, job: jobPda(1) } as any).signers([agent]).rpc();
    await expectError(
      program.methods.setWatchJobStatus(new BN(1), 3).accounts({ authority: stranger.publicKey, policy, job: jobPda(1) } as any).signers([stranger]).rpc(),
      "NotAuthorized",
    );
    await program.methods.setWatchJobStatus(new BN(1), 3).accounts({ authority: owner.publicKey, policy, job: jobPda(1) } as any).rpc();
    assert.equal((await program.account.watchJob.fetch(jobPda(1))).status, 3);
  });

  it("only lets the owner change the policy", async () => {
    const [strangerPolicy] = PublicKey.findProgramAddressSync([Buffer.from("policy"), stranger.publicKey.toBuffer()], program.programId);
    // A stranger cannot pass the owner's policy account: the seeds bind the policy to the signer.
    await expectError(program.methods.revokeAgent().accounts({ owner: stranger.publicKey, policy } as any).signers([stranger]).rpc(), "ConstraintSeeds");
    await expectError(program.methods.revokeAgent().accounts({ owner: stranger.publicKey, policy: strangerPolicy } as any).signers([stranger]).rpc(), "AccountNotInitialized");
  });

  describe("token vault", () => {
    let mint: PublicKey;
    let ownerToken: PublicKey;
    let vaultToken: PublicKey;
    let recipientToken: PublicKey;
    let strangerToken: PublicKey;

    before(async () => {
      mint = await createMint(provider.connection, owner.payer, owner.publicKey, null, 6);
      ownerToken = (await getOrCreateAssociatedTokenAccount(provider.connection, owner.payer, mint, owner.publicKey)).address;
      recipientToken = (await getOrCreateAssociatedTokenAccount(provider.connection, owner.payer, mint, feeRecipient.publicKey)).address;
      strangerToken = (await getOrCreateAssociatedTokenAccount(provider.connection, owner.payer, mint, stranger.publicKey)).address;
      vaultToken = getAssociatedTokenAddressSync(mint, policy, true);
      await mintTo(provider.connection, owner.payer, mint, ownerToken, owner.publicKey, 1_000e6);
      // A new day of limits for the spend tests.
      await program.methods.updatePolicy(policyArgs({ dailyLimitUsd: USD(10_000) }) as any).accounts({ owner: owner.publicKey, policy } as any).rpc();
    });

    const funds = { tokenProgram: TOKEN_PROGRAM_ID };

    it("deposits and withdraws as the owner", async () => {
      await program.methods.deposit(USD(400)).accounts({ owner: owner.publicKey, policy, mint, ownerToken, vaultToken, ...funds } as any).rpc();
      assert.equal(Number((await getAccount(provider.connection, vaultToken)).amount), 400e6);
      await program.methods.withdraw(USD(100)).accounts({ owner: owner.publicKey, policy, mint, ownerToken, vaultToken, ...funds } as any).rpc();
      assert.equal(Number((await getAccount(provider.connection, vaultToken)).amount), 300e6);
    });

    it("lets the agent pay an allowed recipient only", async () => {
      await program.methods.agentSpend(USD(20)).accounts({ agent: agent.publicKey, policy, mint, vaultToken, recipientToken, ...funds } as any).signers([agent]).rpc();
      assert.equal(Number((await getAccount(provider.connection, recipientToken)).amount), 20e6);
      await expectError(
        program.methods.agentSpend(USD(20)).accounts({ agent: agent.publicKey, policy, mint, vaultToken, recipientToken: strangerToken, ...funds } as any).signers([agent]).rpc(),
        "RecipientNotAllowed",
      );
    });

    it("blocks the agent after a revoke and still lets the owner withdraw", async () => {
      await program.methods.revokeAgent().accounts({ owner: owner.publicKey, policy } as any).rpc();
      await expectError(
        program.methods.agentSpend(USD(1)).accounts({ agent: agent.publicKey, policy, mint, vaultToken, recipientToken, ...funds } as any).signers([agent]).rpc(),
        "AgentRevoked",
      );
      await expectError(authorize(agent, 4, CHAIN.arbitrum, PROTOCOL.aave, 1), "AgentRevoked");
      await program.methods.withdraw(USD(280)).accounts({ owner: owner.publicKey, policy, mint, ownerToken, vaultToken, ...funds } as any).rpc();
      assert.equal(Number((await getAccount(provider.connection, vaultToken)).amount), 0);
    });
  });
});
