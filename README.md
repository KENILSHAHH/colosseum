# DeFi Agent

A chat app with one AI agent for DeFi. The user funds an agent wallet. The agent reads protocol docs, builds what a request needs, acts from the wallet, and shows the position and the transaction ids.

Chains: Ethereum, Arbitrum, Base, Robinhood Chain, Hyperliquid (HyperCore, HIP-3, HIP-4), Solana (read), Tempo. Mainnet only.

## Layout

```text
apps/web        Next.js chat UI, Positions tab, agent wallet panel
apps/api        Hono API: wallet sign-in, chat stream, MPP gate, intents, withdrawals
apps/guard      Liquidation Guard watcher (run two copies)
packages/core   Agent loop (Claude Agent SDK), typed tools, adapters, executors, billing, wallet
.claude/skills  Protocol knowledge the agent loads (also used by Claude Code in this repo)
parked/         Stopped work. Not part of the product.
```

## Run

```bash
pnpm install
createdb defi_agent
cp .env.example .env        # then set ANTHROPIC_API_KEY and KEY_ENCRYPTION_SECRET
pnpm dev:api                # http://localhost:8787
pnpm dev:web                # http://localhost:3000
pnpm dev:guard              # watcher; start a second copy with WATCHER_ID=b
```

Tests: `pnpm --filter @app/core test`. Live adapter check: `cd packages/core && npx tsx scripts/smoke-adapters.mts`.

## How an action runs

1. The agent calls a typed tool, for example `hl_open_position`.
2. The tool builds a preview from live data and checks the user's limit per action.
3. The tool executes from the agent wallet, or waits for a confirmation click when "Act without asking" is off.
4. Plain code sends the transactions, reads the receipts, and stores the result. The chat shows a card with the ids.

When no typed tool fits, the agent writes a script or a contract in its sandboxed workspace, tests it on a fork, and sends it with `evm_send_transactions`.

## Security notes

- The agent wallet is custodial. The server holds each key, encrypted with AES-256-GCM. Use AWS KMS for the secret in production.
- The agent subprocess has no signing key and no Claude API key. It reaches Claude through a local proxy with a session token.
- Withdrawals go to the user's sign-in address only.
- Contracts that the agent writes have no audit.
