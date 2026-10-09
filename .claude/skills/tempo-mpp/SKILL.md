---
name: tempo-mpp
description: Tempo chain and the Machine Payments Protocol (MPP). HTTP 402 challenges, charge and session intents, the mppx TypeScript SDK, Tempo network details, OUSD, access keys, fee tokens. Use for billing, payment gating, pricing, receipts, or any Tempo question.
---

# Tempo and MPP

Verified against mpp.dev and tempo.xyz/developers on 2026-10-11.
Indexes: https://mpp.dev/llms.txt and https://tempo.xyz/developers/llms.txt (full text: `llms-full.txt`).

## Tempo network

| | Mainnet | Testnet (Moderato) |
|---|---|---|
| Chain ID | 4217 | 42431 |
| RPC | `https://rpc.tempo.xyz` | `https://rpc.moderato.tempo.xyz` |
| WS | `wss://rpc.tempo.xyz` | `wss://rpc.moderato.tempo.xyz` |
| Explorer | `https://explore.tempo.xyz` | `https://explore.testnet.tempo.xyz` |

- There is no native gas token. Fees are paid in a USD stablecoin (TIP-20). Read balances as TIP-20 balances.
- OUSD on Tempo: `0x20c0000000000000000000006a37DA5C996874BE`. This is the default MPP currency.
- Session reserve precompile (TIP-1034): `0x4d50500000000000000000000000000000000000`.
- viem: `import { Account, createClient, P256 } from 'viem/tempo'`. Chains: `viem/chains` (`tempo`, `tempoModerato`).
- Browser wallet: the `accounts` package (`Provider.create`, `wallet_connect`, `getAccount({ signable: true })`).
- Access keys: the root account authorizes a key with an expiry, per-token limits and call scopes (`client.accessKey.authorizeSync`). The root can revoke it (`revokeSync`). A revoked key cannot be authorized again.
- Bridges into Tempo: LayerZero (Stargate), Relay (chain id 4217), Bungee.
- DeFi on Tempo: enshrined stablecoin DEX (orderbook precompile), Morpho (the Morpho API lists chain 4217).

## MPP in one paragraph

A server answers a request with HTTP 402 and a `WWW-Authenticate` challenge. The challenge states price, method and terms. The client signs a credential and retries. The server verifies, serves the resource and attaches a receipt.

## Intents

- `charge`: one payment per request. On Tempo the client signs a TIP-20 transfer and the server broadcasts it. It settles in about 500 ms.
- `session`: pay as you go. The client deposits once into the reserve. Then it signs cumulative vouchers off-chain. The server checks a signature only. Settlement is batched. Unused deposit returns on close.
- `subscription`: recurring fixed payment through a scoped access key.

## Server (mppx 0.13.x)

```ts
import { Mppx, Store, tempo } from 'mppx/server'

const mppx = Mppx.create({
  secretKey: process.env.MPP_SECRET_KEY!,           // openssl rand -hex 32
  methods: [
    tempo.charge({ currencies: [OUSD], recipient: RECIPIENT, testnet: false }),
    tempo.session({ account, chainId: 4217, currencies: [OUSD], sse: true, store: Store.memory() }),
  ],
})

const result = await mppx.charge({ amount: '0.05' })(request)
if (result.status === 402) return result.challenge
return result.withReceipt(Response.json({ ok: true }))
```

- Framework entry points: `mppx/nextjs`, `mppx/hono`, `mppx/express`. Manual mode: `mppx/server`.
- Streaming: `result.withReceipt(async function* (stream) { await stream.charge(); yield chunk })`. `stream.charge(2_000n)` sets an explicit amount in base units for the next event.
- The session store must have an atomic `update(key, fn)`. `Store.memory()` is for one process only.
- `feePayer: true` makes the server sponsor the fee.
- Validate with `npx mppx validate <url>`.

## Client

```ts
import { tempo } from 'mppx/client'
const session = tempo.session.manager({ account, maxDeposit: '5' })
const stream = await session.sse('/api/chat')     // signs vouchers as the server charges
const receipt = await session.close()             // settles and refunds the rest
```

- One-shot: `Mppx.create({ methods: [tempo({ account, maxDeposit: '1' })], polyfill: false }).fetch(url)`.
- A channel does not close automatically. The deposit stays reserved until close or expiry.
- Session receipts hold the channel id in `reference`. The tx hash exists only after close.

## Other MPP rails

Solana (charge and session), generic EVM (x402-compatible charge), Stripe, card, Lightning, Stellar, XRPL, Monad, NEAR Intents. `Mppx.compose` offers several methods on one route.

## Pricing rule for this product

Each prompt costs one flat `charge` of `PRICE_PROMPT_USD` (0.01 USD) in OUSD. Actions and guard time are free for now.
The payer is the agent wallet of the user. The API holds that key, so the API is the MPP client: `POST /chat` calls the paid route `POST /paid/chat`, gets the 402 challenge, signs one TIP-20 transfer and tries again.
The agent wallet must hold OUSD on Tempo. The user sends OUSD to it, or bridges USDC to it through Relay (`POST /billing/topup`).
