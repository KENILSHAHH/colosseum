---
name: robinhood-chain
description: Robinhood Chain facts. Arbitrum Orbit L2 with ETH gas, stock tokens, network details, bridge contracts, Morpho and Uniswap and Lighter presence. Use for any Robinhood Chain or tokenized stock question.
---

# Robinhood Chain

Source: https://docs.robinhood.com/chain (checked 2026-10-11). The chain is live.

| | Mainnet | Testnet |
|---|---|---|
| Chain ID | 4663 | 46630 |
| Public RPC | `https://rpc.mainnet.chain.robinhood.com` | `https://rpc.testnet.chain.robinhood.com` |
| Explorer | `robinhoodchain.blockscout.com` | `explorer.testnet.chain.robinhood.com` |
| Gas token | ETH | ETH |

- Recommended RPC: Alchemy `https://robinhood-mainnet.g.alchemy.com/v2/{KEY}`.
- Type: Arbitrum Orbit L2. Standard Arbitrum precompiles exist (`ArbSys` at `0x64`).
- WETH: `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`. USDG: `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`.
- L2 Multicall: `0x2cAC2D899eCC914d704FeaAE33ac1bF36277DaD1`. Permit2: `0x000000000022D473030F116dDEE9F6B43aC78BA3`.
- L1 Gateway Router (Ethereum): `0x6a2E3a1e16FC29f27Ce61429746D558d656975bB`.

## Stock tokens

- The official list is an on-chain registry shown at `/chain/contracts`. The page loads it live.
- A token with a matching ticker and a different address is not a Robinhood Stock Token. Verify the address against the registry before any action.
- Pages: `/chain/stock-tokens`, `/chain/building-with-stock-tokens`, `/chain/stock-token-apis`, `/chain/oracles-and-price-feeds`.

## Protocols

- Morpho: `api.morpho.org/graphql` lists chain 4663.
- Uniswap and Lighter are listed as ecosystem partners. The docs page gives no contract addresses for them. Get addresses from each protocol's own deployment list.
- Relay bridges to chain 4663 and to `robinhood-lighter` (id 548123634).
- DefiLlama yields use the chain name `Robinhood Chain`.
