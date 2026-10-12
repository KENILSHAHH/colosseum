create table if not exists users (
  id            text primary key,              -- lower-case EVM address of the owner: the Privy embedded wallet, or the wallet of an older sign-in
  solana_address text,
  created_at    timestamptz not null default now()
);
alter table users add column if not exists privy_did text unique;  -- Privy user id (did:privy:...)
alter table users add column if not exists linked_wallet text;     -- the user's own wallet, proven with a signature
-- The Privy wallet of the user is the deposit address. Tokens that arrive there are converted to OUSD on Tempo.
alter table users add column if not exists deposit_wallet text;
alter table users add column if not exists privy_wallet_id text;
alter table users add column if not exists deposit_signer boolean not null default false;  -- the user added the server signer

-- One row per conversion attempt of a deposit.
create table if not exists deposits (
  id            bigserial primary key,
  user_id       text not null references users(id),
  chain_id      integer not null,
  chain_name    text not null,
  token         text not null,
  symbol        text not null,
  amount        numeric not null,
  usd           numeric,
  status        text not null,                  -- converted | needs_gas | failed
  hash          text,
  expected_ousd numeric,
  detail        text,
  created_at    timestamptz not null default now()
);
create index if not exists deposits_user on deposits(user_id, created_at desc);

-- Permissions the user signed on the linked wallet (EIP-7702 delegations to the agent wallet).
create table if not exists delegations (
  id            text primary key,
  user_id       text not null references users(id),
  owner         text not null,                  -- the linked wallet, lower case
  chain         text not null,
  targets       jsonb not null,                 -- contracts the agent can call
  selectors     jsonb not null,                 -- function signatures the agent can call
  max_value_wei text not null default '0',      -- native value limit per call
  expires_at    timestamptz not null,
  reason        text not null,
  delegation    jsonb not null,                 -- the unsigned delegation
  signature     text,                           -- set when the user grants it; cleared when removed
  status        text not null default 'pending',-- pending | active | rejected | removed
  created_at    timestamptz not null default now()
);
create index if not exists delegations_user on delegations(user_id, status);

-- Hyperliquid agent wallets. The key can trade. It cannot withdraw.
-- The private key is stored encrypted (AES-256-GCM, key from KMS or KEY_ENCRYPTION_SECRET).
create table if not exists hl_agents (
  user_id       text primary key references users(id),
  agent_address text not null,
  enc_key       text not null,
  agent_name    text not null,
  approved      boolean not null default false,
  created_at    timestamptz not null default now()
);

create table if not exists intents (
  id          text primary key,
  user_id     text not null references users(id),
  kind        text not null,
  params      jsonb not null,
  preview     jsonb not null,
  intent_hash text not null,                    -- sha256 of kind + params; written to the Solana action log
  status      text not null default 'pending',  -- pending | confirmed | executing | done | failed | rejected | expired
  fee_usd     numeric not null default 0,
  result      jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists intents_user on intents(user_id, created_at desc);

create table if not exists usage (
  id            bigserial primary key,
  user_id       text not null references users(id),
  session_id    text,
  model         text not null,
  input_tokens  bigint not null default 0,
  output_tokens bigint not null default 0,
  cache_read    bigint not null default 0,
  cache_write   bigint not null default 0,
  cost_usd      numeric not null,               -- Claude cost
  charged_usd   numeric not null,               -- price charged through MPP
  created_at    timestamptz not null default now()
);
create index if not exists usage_user_day on usage(user_id, created_at);

create table if not exists charges (
  id          bigserial primary key,
  user_id     text not null references users(id),
  kind        text not null,                    -- prompt | action | guard
  amount_usd  numeric not null,
  reference   text,                             -- MPP receipt reference (channel id or tx hash)
  detail      jsonb,
  created_at  timestamptz not null default now()
);

create table if not exists guards (
  id            text primary key,
  user_id       text not null references users(id),
  venue         text not null,                  -- hyperliquid | aave
  params        jsonb not null,                 -- asset, trigger, action, max slippage, gas budget
  status        text not null default 'active', -- active | triggered | done | cancelled | failed
  last_value    numeric,
  last_check    timestamptz,
  charged_until timestamptz not null default now(),
  solana_job    text,                           -- WatchJob account address
  created_at    timestamptz not null default now()
);

-- One row per guard firing. The primary key is the idempotency key, so two watchers cannot act twice.
create table if not exists guard_actions (
  idempotency_key text primary key,
  guard_id        text not null references guards(id),
  watcher         text not null,
  decision        jsonb not null,
  status          text not null default 'claimed', -- claimed | done | failed
  result          jsonb,
  created_at      timestamptz not null default now()
);

create table if not exists action_log (
  id           bigserial primary key,
  user_id      text not null references users(id),
  intent_id    text,
  intent_hash  text not null,
  chain        text not null,
  tx_hash      text not null,
  solana_sig   text,                             -- signature of the on-chain log write
  created_at   timestamptz not null default now()
);

-- One agent wallet per user. The server holds the key (encrypted). The user funds it and the agent acts from it.
create table if not exists agent_wallets (
  user_id        text primary key references users(id),
  evm_address    text not null unique,
  enc_key        text not null,
  auto_execute   boolean not null default true,   -- false = every action waits for a confirmation click
  max_action_usd numeric not null default 250,    -- hard limit per action
  created_at     timestamptz not null default now()
);

-- One row per transaction that the gas sponsor sent for a user (EIP-7702).
create table if not exists sponsored_txs (
  id           bigserial primary key,
  user_id      text not null references users(id),
  chain        text not null,
  hash         text not null,
  gas_cost_wei text not null,
  success      boolean not null,
  created_at   timestamptz not null default now()
);
create index if not exists sponsored_txs_user on sponsored_txs(user_id, created_at desc);

-- Scheduled jobs: a condition and a prepared action. The server fires the action when the condition is true.
create table if not exists jobs (
  id          text primary key,
  user_id     text not null references users(id),
  name        text not null,
  condition   jsonb not null,
  action      jsonb not null,
  status      text not null default 'active',   -- active | running | done | failed | cancelled | expired
  last_value  numeric,
  last_check  timestamptz,
  expires_at  timestamptz not null,
  result      jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists jobs_active on jobs(status) where status = 'active';
create index if not exists jobs_user on jobs(user_id, created_at desc);
