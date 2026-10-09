//! Permission layer of the DeFi agent.
//!
//! The owner (user wallet) sets a spend policy and names one agent key.
//! Before the backend executes an action on any chain, the agent key must get an
//! on-chain authorization from this program. The program checks the policy and
//! writes an action log entry. After execution the agent stores the destination
//! transaction id. The owner can revoke the agent with one transaction. That
//! transaction needs only the owner's wallet and a Solana RPC.
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

declare_id!("3MBkyoRUKdNxFBewf9vaz8FZhFCW1xizjMH3hn4DfznK");

pub const MAX_SPEND_RECIPIENTS: usize = 4;
pub const MAX_TX_REF_LEN: usize = 88; // a base58 Solana signature is at most 88 characters
pub const SECONDS_PER_DAY: i64 = 86_400;

#[program]
pub mod vault {
    use super::*;

    pub fn initialize_policy(ctx: Context<InitializePolicy>, args: PolicyArgs) -> Result<()> {
        let policy = &mut ctx.accounts.policy;
        policy.owner = ctx.accounts.owner.key();
        policy.bump = ctx.bumps.policy;
        policy.day_start = Clock::get()?.unix_timestamp;
        policy.apply(args)
    }

    /// Owner only. Sets a new agent, new limits or new allow-lists. It clears a revocation.
    pub fn update_policy(ctx: Context<OwnerOnly>, args: PolicyArgs) -> Result<()> {
        ctx.accounts.policy.apply(args)
    }

    /// Owner only. After this call every agent instruction fails.
    pub fn revoke_agent(ctx: Context<OwnerOnly>) -> Result<()> {
        let policy = &mut ctx.accounts.policy;
        policy.revoked = true;
        emit!(AgentRevoked { owner: policy.owner, agent: policy.agent });
        Ok(())
    }

    /// Agent only. Checks the policy, reserves the spend, and opens a log entry.
    /// The backend executes on the destination chain only after this succeeds.
    pub fn authorize_action(
        ctx: Context<AuthorizeAction>,
        intent_hash: [u8; 32],
        chain: u8,
        protocol: u8,
        usd_size: u64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let policy = &mut ctx.accounts.policy;
        require!(chain < 16 && policy.allowed_chains & (1u16 << chain) != 0, VaultError::ChainNotAllowed);
        require!(protocol < 64 && policy.allowed_protocols & (1u64 << protocol) != 0, VaultError::ProtocolNotAllowed);
        policy.reserve_spend(usd_size, now)?;

        let log = &mut ctx.accounts.action_log;
        log.owner = policy.owner;
        log.seq = policy.action_seq;
        log.intent_hash = intent_hash;
        log.chain = chain;
        log.protocol = protocol;
        log.usd_size = usd_size;
        log.status = ActionStatus::Authorized as u8;
        log.authorized_at = now;
        log.bump = ctx.bumps.action_log;
        policy.action_seq = policy.action_seq.checked_add(1).ok_or(VaultError::Overflow)?;

        emit!(ActionAuthorized { owner: log.owner, seq: log.seq, intent_hash, chain, protocol, usd_size });
        Ok(())
    }

    /// Agent only. Stores the destination transaction id. A failed action returns its reserved spend.
    pub fn finalize_action(ctx: Context<FinalizeAction>, _seq: u64, success: bool, tx_ref: String) -> Result<()> {
        require!(tx_ref.len() <= MAX_TX_REF_LEN, VaultError::TxRefTooLong);
        let now = Clock::get()?.unix_timestamp;
        let log = &mut ctx.accounts.action_log;
        require!(log.status == ActionStatus::Authorized as u8, VaultError::AlreadyFinalized);
        log.status = if success { ActionStatus::Executed as u8 } else { ActionStatus::Failed as u8 };
        log.tx_ref = tx_ref.clone();
        log.finalized_at = now;

        if !success {
            let policy = &mut ctx.accounts.policy;
            // The refund applies only inside the day that reserved the spend.
            if log.authorized_at >= policy.day_start {
                policy.spent_today_usd = policy.spent_today_usd.saturating_sub(log.usd_size);
            }
        }
        emit!(ActionFinalized { owner: log.owner, seq: log.seq, success, tx_ref });
        Ok(())
    }

    /// Owner or active agent. Registers a liquidation guard job.
    pub fn register_watch_job(ctx: Context<RegisterWatchJob>, job_id: u64, args: WatchJobArgs) -> Result<()> {
        require!(args.max_slippage_bps <= 10_000, VaultError::InvalidArgument);
        let job = &mut ctx.accounts.job;
        job.owner = ctx.accounts.policy.owner;
        job.job_id = job_id;
        job.venue = args.venue;
        job.asset_hash = args.asset_hash;
        job.trigger_kind = args.trigger_kind;
        job.trigger_value = args.trigger_value;
        job.action = args.action;
        job.max_slippage_bps = args.max_slippage_bps;
        job.gas_budget_usd = args.gas_budget_usd;
        job.status = JobStatus::Active as u8;
        job.created_at = Clock::get()?.unix_timestamp;
        job.bump = ctx.bumps.job;
        emit!(WatchJobRegistered { owner: job.owner, job_id, venue: job.venue });
        Ok(())
    }

    /// Owner or active agent. The owner can always cancel. The agent marks a job triggered or done.
    pub fn set_watch_job_status(ctx: Context<SetWatchJobStatus>, _job_id: u64, status: u8) -> Result<()> {
        require!(status <= JobStatus::Cancelled as u8, VaultError::InvalidArgument);
        ctx.accounts.job.status = status;
        Ok(())
    }

    /// Owner only. Moves tokens from the owner into the vault token account.
    pub fn deposit(ctx: Context<MoveFunds>, amount: u64) -> Result<()> {
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.owner_token.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault_token.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )
    }

    /// Owner only. Works when the agent is revoked. Funds can always leave to the owner.
    pub fn withdraw(ctx: Context<MoveFunds>, amount: u64) -> Result<()> {
        let owner = ctx.accounts.owner.key();
        let seeds: &[&[u8]] = &[b"policy", owner.as_ref(), &[ctx.accounts.policy.bump]];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault_token.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.owner_token.to_account_info(),
                    authority: ctx.accounts.policy.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            ctx.accounts.mint.decimals,
        )
    }

    /// Agent only. Pays from the vault to a recipient on the owner's allow-list.
    /// The amount counts against the trade limit and the daily limit. The mint must be a 6-decimal USD stablecoin.
    pub fn agent_spend(ctx: Context<AgentSpend>, amount: u64) -> Result<()> {
        require!(ctx.accounts.mint.decimals == 6, VaultError::UnsupportedMint);
        let now = Clock::get()?.unix_timestamp;
        let recipient = ctx.accounts.recipient_token.owner;
        let policy = &mut ctx.accounts.policy;
        require!(policy.spend_recipients.contains(&recipient) && recipient != Pubkey::default(), VaultError::RecipientNotAllowed);
        policy.reserve_spend(amount, now)?;

        let seeds: &[&[u8]] = &[b"policy", policy.owner.as_ref(), &[policy.bump]];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault_token.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.recipient_token.to_account_info(),
                    authority: policy.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            ctx.accounts.mint.decimals,
        )
    }
}

// ── State ───────────────────────────────────────────────────────────────────

#[account]
#[derive(InitSpace)]
pub struct Policy {
    pub owner: Pubkey,
    pub agent: Pubkey,
    /// Largest single action, in USD with 6 decimals.
    pub max_trade_usd: u64,
    /// Total per rolling day, in USD with 6 decimals.
    pub daily_limit_usd: u64,
    /// Bit flags. The bit positions are in `packages/core/src/registry/chains.ts`.
    pub allowed_chains: u16,
    pub allowed_protocols: u64,
    pub revoked: bool,
    pub spent_today_usd: u64,
    pub day_start: i64,
    pub action_seq: u64,
    pub spend_recipients: [Pubkey; MAX_SPEND_RECIPIENTS],
    pub bump: u8,
}

impl Policy {
    fn apply(&mut self, args: PolicyArgs) -> Result<()> {
        require!(args.max_trade_usd <= args.daily_limit_usd, VaultError::InvalidArgument);
        require!(args.agent != self.owner && args.agent != Pubkey::default(), VaultError::InvalidArgument);
        self.agent = args.agent;
        self.max_trade_usd = args.max_trade_usd;
        self.daily_limit_usd = args.daily_limit_usd;
        self.allowed_chains = args.allowed_chains;
        self.allowed_protocols = args.allowed_protocols;
        self.spend_recipients = args.spend_recipients;
        self.revoked = false;
        emit!(PolicyUpdated { owner: self.owner, agent: self.agent, max_trade_usd: self.max_trade_usd, daily_limit_usd: self.daily_limit_usd });
        Ok(())
    }

    fn reserve_spend(&mut self, usd: u64, now: i64) -> Result<()> {
        require!(usd <= self.max_trade_usd, VaultError::TradeTooLarge);
        if now - self.day_start >= SECONDS_PER_DAY {
            self.day_start = now;
            self.spent_today_usd = 0;
        }
        let spent = self.spent_today_usd.checked_add(usd).ok_or(VaultError::Overflow)?;
        require!(spent <= self.daily_limit_usd, VaultError::DailyLimitExceeded);
        self.spent_today_usd = spent;
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct WatchJob {
    pub owner: Pubkey,
    pub job_id: u64,
    pub venue: u8,
    /// sha256 of the venue asset name, for example "xyz:GOLD".
    pub asset_hash: [u8; 32],
    /// 0 = percent distance to liquidation (bps), 1 = health factor (4 decimals).
    pub trigger_kind: u8,
    pub trigger_value: u64,
    /// 0 = full close, 1 = partial deleverage, 2 = add margin.
    pub action: u8,
    pub max_slippage_bps: u16,
    pub gas_budget_usd: u64,
    pub status: u8,
    pub created_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct ActionLog {
    pub owner: Pubkey,
    pub seq: u64,
    pub intent_hash: [u8; 32],
    pub chain: u8,
    pub protocol: u8,
    pub usd_size: u64,
    pub status: u8,
    /// Destination transaction id as text (EVM hash, Solana signature, or Hyperliquid order id).
    #[max_len(MAX_TX_REF_LEN)]
    pub tx_ref: String,
    pub authorized_at: i64,
    pub finalized_at: i64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PolicyArgs {
    pub agent: Pubkey,
    pub max_trade_usd: u64,
    pub daily_limit_usd: u64,
    pub allowed_chains: u16,
    pub allowed_protocols: u64,
    pub spend_recipients: [Pubkey; MAX_SPEND_RECIPIENTS],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct WatchJobArgs {
    pub venue: u8,
    pub asset_hash: [u8; 32],
    pub trigger_kind: u8,
    pub trigger_value: u64,
    pub action: u8,
    pub max_slippage_bps: u16,
    pub gas_budget_usd: u64,
}

#[repr(u8)]
pub enum ActionStatus {
    Authorized = 0,
    Executed = 1,
    Failed = 2,
}

#[repr(u8)]
pub enum JobStatus {
    Active = 0,
    Triggered = 1,
    Done = 2,
    Cancelled = 3,
}

// ── Accounts ────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitializePolicy<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(init, payer = owner, space = 8 + Policy::INIT_SPACE, seeds = [b"policy", owner.key().as_ref()], bump)]
    pub policy: Account<'info, Policy>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OwnerOnly<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"policy", owner.key().as_ref()], bump = policy.bump, has_one = owner)]
    pub policy: Account<'info, Policy>,
}

#[derive(Accounts)]
pub struct AuthorizeAction<'info> {
    #[account(mut)]
    pub agent: Signer<'info>,
    #[account(
        mut,
        seeds = [b"policy", policy.owner.as_ref()],
        bump = policy.bump,
        has_one = agent @ VaultError::NotAgent,
        constraint = !policy.revoked @ VaultError::AgentRevoked,
    )]
    pub policy: Account<'info, Policy>,
    #[account(
        init,
        payer = agent,
        space = 8 + ActionLog::INIT_SPACE,
        seeds = [b"log", policy.owner.as_ref(), &policy.action_seq.to_le_bytes()],
        bump,
    )]
    pub action_log: Account<'info, ActionLog>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(seq: u64)]
pub struct FinalizeAction<'info> {
    pub agent: Signer<'info>,
    #[account(mut, seeds = [b"policy", policy.owner.as_ref()], bump = policy.bump, has_one = agent @ VaultError::NotAgent)]
    pub policy: Account<'info, Policy>,
    #[account(mut, seeds = [b"log", policy.owner.as_ref(), &seq.to_le_bytes()], bump = action_log.bump)]
    pub action_log: Account<'info, ActionLog>,
}

#[derive(Accounts)]
#[instruction(job_id: u64)]
pub struct RegisterWatchJob<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [b"policy", policy.owner.as_ref()],
        bump = policy.bump,
        constraint = authority.key() == policy.owner || (authority.key() == policy.agent && !policy.revoked) @ VaultError::NotAuthorized,
    )]
    pub policy: Account<'info, Policy>,
    #[account(
        init,
        payer = authority,
        space = 8 + WatchJob::INIT_SPACE,
        seeds = [b"job", policy.owner.as_ref(), &job_id.to_le_bytes()],
        bump,
    )]
    pub job: Account<'info, WatchJob>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(job_id: u64)]
pub struct SetWatchJobStatus<'info> {
    pub authority: Signer<'info>,
    #[account(
        seeds = [b"policy", policy.owner.as_ref()],
        bump = policy.bump,
        constraint = authority.key() == policy.owner || (authority.key() == policy.agent && !policy.revoked) @ VaultError::NotAuthorized,
    )]
    pub policy: Account<'info, Policy>,
    #[account(mut, seeds = [b"job", policy.owner.as_ref(), &job_id.to_le_bytes()], bump = job.bump)]
    pub job: Account<'info, WatchJob>,
}

#[derive(Accounts)]
pub struct MoveFunds<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [b"policy", owner.key().as_ref()], bump = policy.bump, has_one = owner)]
    pub policy: Account<'info, Policy>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = owner, token::token_program = token_program)]
    pub owner_token: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = owner,
        associated_token::mint = mint,
        associated_token::authority = policy,
        associated_token::token_program = token_program,
    )]
    pub vault_token: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AgentSpend<'info> {
    pub agent: Signer<'info>,
    #[account(
        mut,
        seeds = [b"policy", policy.owner.as_ref()],
        bump = policy.bump,
        has_one = agent @ VaultError::NotAgent,
        constraint = !policy.revoked @ VaultError::AgentRevoked,
    )]
    pub policy: Account<'info, Policy>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = policy, associated_token::token_program = token_program)]
    pub vault_token: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::token_program = token_program)]
    pub recipient_token: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

// ── Events and errors ───────────────────────────────────────────────────────

#[event]
pub struct PolicyUpdated { pub owner: Pubkey, pub agent: Pubkey, pub max_trade_usd: u64, pub daily_limit_usd: u64 }
#[event]
pub struct AgentRevoked { pub owner: Pubkey, pub agent: Pubkey }
#[event]
pub struct ActionAuthorized { pub owner: Pubkey, pub seq: u64, pub intent_hash: [u8; 32], pub chain: u8, pub protocol: u8, pub usd_size: u64 }
#[event]
pub struct ActionFinalized { pub owner: Pubkey, pub seq: u64, pub success: bool, pub tx_ref: String }
#[event]
pub struct WatchJobRegistered { pub owner: Pubkey, pub job_id: u64, pub venue: u8 }

#[error_code]
pub enum VaultError {
    #[msg("The signer is not the agent of this policy")]
    NotAgent,
    #[msg("The owner revoked the agent")]
    AgentRevoked,
    #[msg("The signer is not the owner or the active agent")]
    NotAuthorized,
    #[msg("The chain is not on the allow-list")]
    ChainNotAllowed,
    #[msg("The protocol is not on the allow-list")]
    ProtocolNotAllowed,
    #[msg("The action is larger than the trade limit")]
    TradeTooLarge,
    #[msg("The action exceeds the daily limit")]
    DailyLimitExceeded,
    #[msg("The recipient is not on the allow-list")]
    RecipientNotAllowed,
    #[msg("The action log entry is already final")]
    AlreadyFinalized,
    #[msg("The transaction reference is too long")]
    TxRefTooLong,
    #[msg("The mint must have 6 decimals")]
    UnsupportedMint,
    #[msg("Invalid argument")]
    InvalidArgument,
    #[msg("Arithmetic overflow")]
    Overflow,
}
