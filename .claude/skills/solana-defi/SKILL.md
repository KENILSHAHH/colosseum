---
name: solana-defi
description: Solana DeFi facts. Jupiter (swap, lend, price), Kamino, World (world.xyz) prediction markets, the on-chain policy vault program of this product. Use for any Solana question, swap, lending rate, prediction market, or vault policy.
---

# Solana DeFi

Endpoints below returned HTTP 200 on 2026-10-11 unless a note says otherwise.

## Jupiter (no API key needed on `lite-api.jup.ag`)

- Price: `GET https://lite-api.jup.ag/price/v3?ids=<mint,mint>` → `{mint:{usdPrice,decimals,liquidity}}`
- Swap order (Ultra): `GET https://lite-api.jup.ag/ultra/v1/order?inputMint=&outputMint=&amount=&taker=<wallet>` → `outAmount`, `priceImpactPct`, `routePlan`, `transaction` (base64, present when `taker` is set), `requestId`
- Swap execute: `POST https://lite-api.jup.ag/ultra/v1/execute` body `{signedTransaction, requestId}`
- Lend (Earn): `GET https://lite-api.jup.ag/lend/v1/earn/tokens` → list with `asset`, `totalRate`/`supplyRate`, `totalAssets`
- Docs: https://developers.jup.ag/docs (repo `jup-ag/docs`). The paid host is `api.jup.ag` with an `x-api-key` header.
- Amounts are in base units. SOL has 9 decimals. USDC has 6.

Common mints:

- SOL (wrapped): `So11111111111111111111111111111111111111112`
- USDC: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`

## Kamino

- Markets: `GET https://api.kamino.finance/v2/kamino-market`
- Reserve metrics: `GET https://api.kamino.finance/kamino-market/<market>/reserves/metrics` → `liquidityToken`, `supplyApy`, `borrowApy`, `totalSupplyUsd`
- SDK: `@kamino-finance/klend-sdk`.

## Cross-venue yield data

`GET https://yields.llama.fi/pools` (DefiLlama) lists `chain`, `project`, `symbol`, `apy`, `tvlUsd`. It covers Solana, Ethereum, Arbitrum, Base, `Hyperliquid L1`, `Tempo` and `Robinhood Chain`. Use it for a fast comparison. Confirm the winning rate against the protocol's own API before an action.

## World (world.xyz) prediction markets

Source: `chainstacklabs/world-xyz-research` (third-party reverse engineering, checked on mainnet 2026-07 to 2026-09). World publishes no IDL and no public docs. Treat every detail as unofficial.

- Program `prediCt`: `prediCtPZCttYMvm2W3PtxmMxLmT1dtN7riU6Cxh6tM`
- Collateral CASH (Token-2022): `CASHx9KJUStyftLFWGvEVf59SGeG9sh5FfcnZMVPCASH`
- Market makers: JanusFI `JanusXpm3gsW3c9ErNoUgHppL8dGLvZKB7uekkJEYFP`, BisonFI `2DNbzPochEcyCcWMbL4d9S3u9QqQEj5bbe6cSZFvKsbh`
- Router: DFlow `DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH`
- A market is one YES mint and one NO mint (Token-2022). `split(N)` locks N CASH and mints N YES plus N NO. `merge(N)` reverses it. Both are permissionless and fee-free.
- Price comes from market-maker quotes, not from an AMM. YES + NO is slightly above 1. The gap is the fee (observed 0% to about 11%).
- One operator key creates, resolves and pays every market. There is no dispute window. Disclose this risk.
- Market account (320 bytes): CASH mint at offset 40, YES mint at 72, NO mint at 104, vault at 136.
- Quotes and trade transactions: DFlow `GET https://quote-api.dflow.net/order?inputMint=&outputMint=&amount=&slippageBps=&userPublicKey=` with an `x-api-key` header. Outcome mints need `/order`, not `/quote`.
- The open World proxies (`markets-api-proxy.world-xyz.workers.dev`, `aggregator-api-proxy.world-xyz.workers.dev`) returned 403 on 2026-10-11. Do not depend on them.
- Without a DFlow key the agent can still read market accounts and token supplies over RPC.

## Policy vault program (this product)

Program source: `programs/vault`. Accounts:

- `Policy` PDA `["policy", owner]`: agent key, max trade size, daily limit, allowed chains (bit flags), allowed protocols (bit flags), revoked flag, spent-today counter.
- `WatchJob` PDA `["job", owner, job_id]`: venue, asset hash, trigger, action, max slippage, status.
- `ActionLog` PDA `["log", owner, seq]`: intent hash, destination chain, destination tx hash, USD size, timestamp.

The agent key can write logs and spend within the policy. Only the owner can change the policy or revoke the agent. Revocation is an on-chain transaction from the owner's wallet. It works when the backend is down.
