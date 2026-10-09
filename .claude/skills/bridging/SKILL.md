---
name: bridging
description: Cross-chain routes between Ethereum, Arbitrum, Base, Solana, Hyperliquid, Tempo and Robinhood Chain. Relay API, CCTP, Across, LI.FI, native bridges. Use when assets must move between chains or when a route, quote, fee or ETA is needed.
---

# Bridging

## Relay (primary route; covers every chain of this product)

- Base URL: `https://api.relay.link`. Docs: https://docs.relay.link/llms.txt
- Chains: `GET /chains`. Checked 2026-10-11:

| Chain | Relay id | VM |
|---|---|---|
| Ethereum | 1 | evm |
| Base | 8453 | evm |
| Arbitrum | 42161 | evm |
| HyperEVM | 999 | evm |
| Hyperliquid (HyperCore) | 1337 | hypevm |
| Tempo | 4217 | evm |
| Robinhood Chain | 4663 | evm |
| Solana | 792703809 | svm |

- Quote: `POST /quote` with `{user, recipient, originChainId, destinationChainId, originCurrency, destinationCurrency, amount, tradeType:"EXACT_INPUT"}`.
- The response has `steps[]` (each with `items[].data` = a transaction to sign), `fees`, `details.timeEstimate`, `details.currencyOut.amountFormatted`.
- Status: `GET /intents/status/v3?requestId=`.
- Read `references/api/api_guides/hyperliquid-support.md` in the Relay docs before a Hyperliquid deposit.

## Other routes

- CCTP (Circle): native USDC burn and mint. Repos `circlefin/evm-cctp-contracts`, `circlefin/solana-cctp-contracts`. Slowest on standard transfers, no bridge spread.
- Across: `https://app.across.to/api/suggested-fees`. Fast on Ethereum, Arbitrum and Base.
- LI.FI: `https://li.quest/v1/quote`. Aggregator over many bridges.
- Robinhood Chain native bridge (Arbitrum Orbit): L1 Gateway Router `0x6a2E3a1e16FC29f27Ce61429746D558d656975bB` on Ethereum. Withdrawals have the Orbit challenge delay.
- Tempo: LayerZero (Stargate) and Relay.

## Route rule

Get quotes from two sources when both support the pair. Show output amount, total fee and ETA. Pick the higher output unless the ETA difference matters for the user's next step. Verify arrival on the destination chain before the next step runs.
