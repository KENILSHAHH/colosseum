# PayI Finance

**Tell an agent what you want to do with your money. It does it on-chain.**

PayI is a chat app with one AI agent for DeFi. You sign in with Google or email. You get a wallet, and you ask in plain words:

> *"Open a 3x long on ETH with 50 USD, stop at 2,300."*
> *"Buy 20 USD of Tesla stock with my USDC."*
> *"Put my USDC where it earns the most, and pull it out if the health factor drops below 1.3."*

The agent reads live markets and official docs. It builds the transactions and simulates them. Then it sends them from your wallet and shows you the result. You pay 0.01 USD per prompt. You do not need gas.

Live at **[app.payi.finance](https://app.payi.finance)** · Mainnet only.

---

## What you can do

| | |
|---|---|
| **Trade perps** | Open, close and size Hyperliquid perps, including HIP-3 markets (gold, stocks, more). Set native stop-loss and take-profit orders. |
| **Buy stocks on-chain** | Buy and sell Robinhood stock tokens (TSLA, NVDA, AAPL, SPY and about 190 more) on Robinhood Chain. The agent uses only addresses from the official Robinhood list. |
| **Lend and borrow** | Supply, borrow, repay and withdraw on Aave v4 and Aave v3. Compare rates across chains, Morpho and Solana venues. |
| **Swap and bridge** | Swap any token for any token on any supported chain through LI.FI. Move funds across chains through Relay. |
| **Unwind in one transaction** | Close a whole leveraged Aave position with a flash loan. The loan repays the debt, frees the collateral and sells only what it must. |
| **Automate** | Schedule jobs: "every day", "when ETH is below 2,000", "when my health factor is below 1.2". The server runs them while you are offline. |
| **Solana** | Swap through Jupiter. Sign any Solana transaction, for example a Kamino deposit. |
| **Predictions** | Hyperliquid HIP-4 outcome markets and Polymarket. |

### One wallet, no gas

- You sign in with Privy, and you get an embedded wallet on EVM chains and on Solana.
- A gas sponsor pays the fees on Ethereum, Arbitrum, Base, Robinhood Chain and Polygon. It uses EIP-7702, so your wallet stays a normal address. All the steps of one action land as one transaction, and they succeed or fail together.
- You can also link your own wallet, for example MetaMask. The agent then asks you to sign each action, or it acts inside a narrow permission that you grant.

### Deposits

Open **Deposit**, then pick a network and a token. Scan the QR code, or send from a connected wallet in one click.

| Network | Tokens |
|---|---|
| Base · Arbitrum · Ethereum | USDC, USDT, ETH, WBTC, DAI, WETH |
| Robinhood Chain | ETH, USDG, USDe, WETH |
| Tempo | USDC.e, USDT0, pathUSD, OUSD |
| Hyperliquid | USDC. It goes to your Hyperliquid account through the official bridge, and the minimum is 5 USDC. |
| Solana | SOL, USDC, USDT, to your own Solana wallet |

### Your account at a glance

The **Positions** tab shows your total value, your open positions and every token in your wallet on every chain. Each row has a token or venue logo and a chain logo.
- **Positions:** Hyperliquid perps with PnL and the distance to liquidation, Aave v3 and v4 with health factors, and Hyperliquid cash.
- **Wallet:** every token on every EVM chain, including Robinhood stock tokens and Tempo, plus Solana.

### An agent that gets better

- The agent saves a short lesson each time it solves an error or finds a working route. Later chats start with those lessons.
- You can send a message while a task runs, and the agent reads it at its next step.
- The side panel shows each step as the agent works.

### Pricing

- 0.01 USD per prompt, paid in OUSD on Tempo through MPP (the Machine Payments Protocol).
- There is no subscription and no daily cap.
- Actions cost only the venue's own fees.

### On-chain examples

Real mainnet transactions that the agent sent from a user wallet in the app. On EVM chains the gas sponsor paid the gas, and the approval and the action landed in one transaction.

| Protocol | What the agent did | Transaction |
|---|---|---|
| **Hyperliquid** | Open a 25x gold long on the HIP-3 market `xyz:GOLD` | [0x6bfd…3ece](https://app.hyperliquid.xyz/explorer/tx/0x6bfdfac0386f64e36d7704466a74ed0201ed00a5d36283b50fc6a612f7633ece) |
| **Aave v3** | Supply 1 USDC on Base | [0x6b95…10c2](https://basescan.org/tx/0x6b9525a9d6a26cb71fdbd7d1bc90b522e82c8a0763b7064b51c4848c383a10c2) |
| **Fluid** | Lend 1 USDC on Base | [0x5c15…3a3c](https://basescan.org/tx/0x5c152757f7b66ef5b8d1be18f64cb1c23dcb22ff381dcddf8daed17071e54a3c) |
| **Jupiter Lend** | Open a SOL/USDC loan on Solana: 0.96 SOL collateral, borrow 50 USDC | [24BV…QmzF](https://solscan.io/tx/24BVJxhARcnswWsxgPgNFuzhZwZs8sUaaWbtemsXSZsja8eyXeJZh61czoCFNi2NLR6uxxGcbB1h22EGfrD9QmzF) |
| **Robinhood Chain** | Buy TSLA stock tokens with 5.08 USDG | [0x89d7…cfb2](https://robinhoodchain.blockscout.com/tx/0x89d7da9fd83eb39b4d92924a3e1a209f93bed70c8e584e905efbecfe4102cfb2) |
| **LI.FI** | Buy TSLA on Robinhood Chain with 2 USDC on Base, in one step | [0x07c2…3272](https://basescan.org/tx/0x07c2fd582b29f76f8f5444811a452f5b00aadec1ef9396433158e7f6be583272) |
| **Relay** | Bridge 49.34 USDC from Arbitrum to Base | [0x8798…810f](https://arbiscan.io/tx/0x87982bda372ca7138382a63b507505045289cabafa7d2a6eedcc2f5e5f58810f) |
| **MPP on Tempo** | Pay 0.01 USD in OUSD for one prompt | [0x0fa8…5740](https://explore.tempo.xyz/tx/0x0fa825165f580f2e45e5f8e17aa5409929c370d77b748c4ac506d34c83685740) |

---

## Safety

- **Simulate first.** The agent simulates every transaction on live chain state before it sends it. If the simulation reverts, nothing is sent.
- **Your rules.** "Act without asking" is a setting. When it is off, each action waits for your click.
- **Narrow permissions.** A permission on a linked wallet names exact contracts, exact functions, a value limit and an end date. You can remove it at any time.
- **Blocked actions.** The agent never signs token permits or delegations to other parties. It never hands control of the Hyperliquid account to another address.
- **Isolated agent.** The agent runs in a sandbox with an allowlist of network hosts. It cannot read server secrets or the workspaces of other users. It holds no signing key and no Claude API key.
- **Official sources only.** The agent takes contract addresses from official lists and docs, for example the Robinhood stock token list, the Aave API and the Hyperliquid docs.

> PayI is a hackathon product on mainnet with real money. The contracts have no audit. Robinhood stock tokens are not available in the US, Canada, the UK, Switzerland and some other countries.

---

## Technical specification

### Architecture

```text
 Browser (Next.js)  ──►  API (Hono)  ──►  Agent run (Claude Agent SDK, sandboxed)
   Privy login            auth, MPP gate      in-process MCP tools ──► adapters ──► chains
   deposit modal          chat stream (SSE)   docs MCP servers         executors (sign + send)
   Positions tab          jobs loop           memory (Postgres)
                          Postgres
```

```text
apps/web          Next.js 15 chat UI, deposit modal, Positions tab, side panel
apps/api          Hono API: Privy sign-in, chat stream, MPP gate, deposits, jobs, permissions, PayBox
apps/landing      Static landing page (payi.finance)
apps/guard        Liquidation watcher (optional; jobs cover most cases)
packages/core     Agent loop, about 45 typed tools, adapters, executors, billing, wallets, jobs, memory
contracts/        FlashExecutor (Solidity)
.claude/skills    Venue knowledge that the agent loads: hyperliquid, evm-lending, bridging,
                  robinhood-chain, solana-defi, tempo-mpp, agent-runtime
```

### Agent

- **Model:** Claude, through the Claude Agent SDK. The effort is set by `CLAUDE_EFFORT` (default `medium`). A run can take up to 300 turns, and it has no cost cap.
- **Tools:** in-process MCP tools. Each tool reads live data, simulates, and returns a preview or a result. Examples:
  - Hyperliquid: `hl_open_position`, `hl_set_tpsl`, `hl_action`.
  - Aave v4: `aave_v4_action`, `aave_v4_unwind`.
  - Swaps and lookups: `swap`, `stock_tokens`, `sol_swap`.
  - Other: `flash_run`, `job_schedule`, `wallet_sign_typed_data`, `memory_save`.
- **Docs MCP servers:** Hyperliquid, Polymarket, Jupiter, Relay, LI.FI, Base and Solana. PayBox is added when the user connects it.
- **Sandbox:** network allowlist, file-system deny rules, and a `PreToolUse` hook on file tools. Each user has a workspace and a run lock.
- **Escape hatch:** when no typed tool fits, the agent writes a script or a contract in its workspace, tests it, and sends it with `evm_send_transactions`.

### Wallets and signing

| Piece | How |
|---|---|
| User wallet (EVM + Solana) | Privy embedded wallets. The server signs through a Privy key quorum signer that the user adds once. |
| Gas sponsorship | EIP-7702 with the MetaMask Delegation Framework (`EIP7702StatelessDeleGator`). A sponsor key relays the calls in a batch. |
| Linked wallet permissions | Delegation Framework caveats: allowed targets, allowed methods, a value limit and a timestamp. Redeemed through `DelegationManager`. |
| Hyperliquid account | A separate server-held key (AES-256-GCM at rest). It signs Hyperliquid exchange actions. |
| Solana fees | The user's Solana wallet pays. Privy fee sponsorship can be switched on with `PRIVY_SOLANA_SPONSOR`. |

### FlashExecutor

One shared contract, deployed with CREATE2 at the same address on Ethereum, Arbitrum, Base and Robinhood Chain. It is verified on Sourcify.

```text
0x075cB7A716bD046bc169CCFc676629dA44AD5Cf1
run(lender, pool, token, amount, steps[], sweep[], recipient)
```

- **Flash loans:** Morpho (no fee) or Aave v3.
- **Steps:** each step runs as the executor, as the agent wallet, or as the user's linked wallet through a delegation.
- **After the loan:** leftover tokens go back to the wallet.

### Integrations

| Area | Provider |
|---|---|
| Perps, spot, outcomes | Hyperliquid API (`@nktkas/hyperliquid`), Bridge2 for deposits |
| Lending | Aave v4 (AaveKit GraphQL `api.aave.com/graphql`), Aave v3, Morpho |
| Swaps and routes | LI.FI (`li.quest/v1`), Relay, Jupiter Ultra |
| Stock tokens | Robinhood asset list `api.robinhood.com/rhj/assets`, prices `/rhj/prices/{symbol}` |
| Balances | LI.FI wallet balances. Robinhood Chain and Tempo are read with Multicall3, with the LI.FI token list for prices and logos. |
| Payments | MPP (`mppx`), OUSD on Tempo |
| Auth | Privy (React SDK, Node SDK) |
| World markets | PayBox (OAuth 2.1 with PKCE) |

### Chains

Ethereum · Arbitrum · Base · Polygon · Robinhood Chain (4663) · Tempo (4217) · HyperEVM (999) · Hyperliquid (HyperCore) · Solana

### Data

Postgres tables:
- **Accounts and wallets:** `users`, `agent_wallets`, `delegations`
- **Chat:** `chats`, `chat_messages`, `intents`, `action_log`
- **Automation:** `jobs`, `guards`
- **Money:** `deposits`, `sponsored_txs`, `usage`, `usage_snapshots`, `charges`
- **Agent memory:** `agent_memory`
- **PayBox:** `paybox_auth`, `paybox_tokens`

The schema is in `packages/core/src/schema.sql`.

### Jobs

A loop on the API server checks each active job every few seconds. It runs the job when the condition is true.
- **Conditions:** price, Aave v4 or v3 health factor, time.
- **Actions:** fixed transactions, Aave v4 steps, an Aave v4 unwind, a swap, a Hyperliquid order, or `agent_task` (the agent runs an instruction with all its tools).
- **Repeats:** a job can repeat with `everySeconds` and `times`.

The server builds the action again and simulates it before it sends it.

---

## Run it locally

Requirements: Node 22+, pnpm, Postgres.

```bash
pnpm install
createdb defi_agent
touch .env          # then add the settings below
pnpm db:migrate
pnpm dev:api        # http://localhost:8787
pnpm dev:web        # http://localhost:3000
```

Main settings in `.env`:

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY`, `CLAUDE_MODEL`, `CLAUDE_EFFORT` | The agent model |
| `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_SIGNER_ID`, `PRIVY_AUTHORIZATION_KEY` | Sign-in and server signing |
| `SPONSOR_PRIVATE_KEY` | The gas sponsor (EIP-7702 relayer) |
| `KEY_ENCRYPTION_SECRET` | Encryption of server-held keys |
| `MPP_ENABLED`, `MPP_RECIPIENT`, `PRICE_PROMPT_USD` | Pay per prompt |
| `RPC_*` | One RPC for each chain |
| `DATABASE_URL` | Postgres |

Checks:

```bash
pnpm typecheck
pnpm --filter @app/core test
cd apps/api && npx tsx scripts/agent-eval.mts   # 26 dry-run scenarios against the real agent
```

## Deploy

The app runs on one EC2 host:
- Caddy serves TLS. It sends `/api/*` to the API on port 8787, and everything else to Next.js on port 3000.
- Both run as systemd services.
- The server keeps its own `.env`.

To deploy, sync the repo, run `pnpm install`, build `apps/web`, and restart both services.
