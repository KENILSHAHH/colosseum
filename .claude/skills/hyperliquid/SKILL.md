---
name: hyperliquid
description: Hyperliquid facts for trading and risk work. HyperCore perps and spot, HIP-3 builder-deployed perps (gold, silver, equities), HIP-4 outcome markets, agent wallets, builder codes, asset IDs, websocket feeds, liquidation data. Use for any Hyperliquid question, order, position, or guard.
---

# Hyperliquid

Verified against the official GitBook and the live mainnet API on 2026-10-11.
Docs index: https://hyperliquid.gitbook.io/hyperliquid-docs/llms.txt (append `.md` to any page URL for markdown).

## Endpoints

- Info (read): `POST https://api.hyperliquid.xyz/info`
- Exchange (write): `POST https://api.hyperliquid.xyz/exchange`
- Websocket: `wss://api.hyperliquid.xyz/ws`
- TypeScript SDK: `@nktkas/hyperliquid` (`InfoClient`, `ExchangeClient`, `SubscriptionClient`, `HttpTransport`, `WebSocketTransport`). Types can change in patch releases.

## Asset IDs (never guess, always compute from live meta)

- Core perp: index in `meta.universe` (BTC = 0).
- Spot: `10000 + spotMeta index`.
- HIP-3 perp: `100000 + perp_dex_index * 10000 + index_in_that_dex_meta`.
- HIP-3 coin name format: `{dex}:{COIN}`, for example `xyz:GOLD`.
- `perpDexs` returns an array. Element 0 is `null` (the core dex). The array position is `perp_dex_index`.

Live snapshot 2026-10-11 (re-read before use, lists change):

| Market | Asset id | Max lev | Note |
|---|---|---|---|
| `xyz:GOLD` | 110003 | 25 | HIP-3 perp, dex `xyz` (index 1), USDC collateral, cross allowed, about 5.9M USD daily volume |
| `PAXG` | 187 | 10 | Core dex perp on tokenized gold |

Other dexes (`flx`, `vntl`, `hyna`, `km`, `cash`, `mkts`) list gold markets with `isDelisted: true`. Skip every entry with `isDelisted`. Live dexes with markets on this date: core, `xyz`, `para`, `mkts`, `io`.

"Gold" is ambiguous. Always ask the user which market. Each dex has its own collateral token (`meta.collateralToken`: 0 = USDC, others differ), oracle, fees and liquidity.

## Key info requests

- `{"type":"perpDexs"}`
- `{"type":"allPerpMetas"}` → one `[meta]` per dex
- `{"type":"metaAndAssetCtxs","dex":""}` → `markPx`, `oraclePx`, `funding`, `openInterest`
- `{"type":"clearinghouseState","user":"0x..","dex":""}` → `assetPositions[].position.{coin,szi,entryPx,liquidationPx,marginUsed,leverage}`, `marginSummary.accountValue`, `withdrawable`
- `{"type":"activeAssetData","user":"0x..","coin":"xyz:GOLD"}` → `leverage`, `maxTradeSzs`, `availableToTrade`, `markPx`
- `{"type":"perpDexLimits","dex":"xyz"}` → OI caps
- `{"type":"outcomeMeta"}` → HIP-4 outcomes
- `{"type":"maxBuilderFee","user":"0x..","builder":"0x.."}`

Query with the master account address. The agent wallet address returns empty data.

## Order action

```json
{"type":"order","orders":[{"a":110003,"b":true,"p":"4100","s":"0.12","r":false,
  "t":{"limit":{"tif":"Ioc"}}}],"grouping":"na","builder":{"b":"0xbuilder","f":10}}
```

- `r: true` = reduce-only. Guard unwinds use reduce-only IOC orders in chunks.
- `f` is in tenths of a basis point. `10` = 1 bp. Max 0.1% on perps.
- A market order is an IOC limit with a price beyond the book (slippage bound).
- Prices: max 5 significant figures and max `6 - szDecimals` decimals for perps. Sizes: round to `szDecimals`.
- `updateLeverage`: `{"type":"updateLeverage","asset":A,"isCross":true,"leverage":5}`.
- `updateIsolatedMargin`: `ntli` has 6 decimals. This adds margin to an isolated position.
- Move collateral into a HIP-3 dex: `sendAsset` with `sourceDex:""`, `destinationDex:"xyz"`. Only the dex collateral token can move.

## This product signs as the account itself

The agent wallet is the Hyperliquid account. It signs orders with its own key. A deposit creates the account. Minimum order value is 10 USD, so 2 USD margin needs 5x leverage or more. Base taker fee is 0.045%. HIP-3 markets scale that fee by the deployer fee scale (up to 2x).

## Agent (API) wallets (not used by this product now)

- The user signs `approveAgent` once with the main wallet (EIP-712, `signatureChainId` `0xa4b1`).
- The agent can sign trading actions. It cannot sign `withdraw3`, `usdSend`, `approveBuilderFee` or `approveAgent`. Those need the main wallet.
- A named agent replaces the agent with the same name. The user can revoke by approving a new agent with the same name. This works without our backend.
- Never reuse an agent address. Use one agent per process. Nonces: millisecond timestamps, tracked per signer.

## Builder codes (revenue)

- The user signs `approveBuilderFee` with the main wallet. Max 10 approvals per user.
- The builder address needs 100 USDC or more in perps account value.
- Fees are claimed through the referral reward claim.

## Liquidation guard data

- Subscribe `clearinghouseState` (per dex), `allMids` (per dex), `userEvents`, `userFills`, `orderUpdates`.
- Distance to liquidation = `abs(markPx - liquidationPx) / markPx`.
- HIP-3 risks to disclose: deployer-set oracle, OI caps, ADL fallback, `haltTrading` settlement, thin books. A guard reduces risk. It cannot guarantee a result when price gaps.

## HIP-4 outcome markets (prediction markets)

- Live on mainnet. Fully collateralized, no leverage, no liquidation. Quote token USDC.
- `outcomeMeta.outcomes[]`: `outcome` (id), `name` (template), `description` (pipe-separated params), `sideSpecs` (Yes/No names), `venue`.
- Yes and No books are merged. A buy Yes at `p` matches a sell No at `1 - p`.
- Trading uses the spot-like order API. Read the asset-ids page and the exchange-endpoint page (split, merge, negate) before the first order.
- Settlement pays `settleFraction` to Yes and `1 - settleFraction` to No.

## Funding the account

- Relay (`api.relay.link`) lists `hyperliquid` as chain id `1337`. It can deposit from Base, Arbitrum, Ethereum, Solana and Tempo.
- `withdraw3` costs about 1 USDC and takes about 5 minutes. Main wallet only.
