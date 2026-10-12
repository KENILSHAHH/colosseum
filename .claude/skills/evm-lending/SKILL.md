---
name: evm-lending
description: Aave v3, Aave v4 and Morpho on Ethereum, Arbitrum, Base, Tempo and Robinhood Chain. Supply, borrow, health factor, flash-loan unwind, address sources. Use for lending rates, leveraged positions, health factor guards, or any Aave or Morpho question.
---

# EVM lending

## Address rule

Contract addresses come from official address books only. Never take an address from prose or from model memory.

- Aave: npm `@bgd-labs/aave-address-book` (`AaveV3Ethereum`, `AaveV3Arbitrum`, `AaveV3Base`). Fields: `POOL`, `POOL_ADDRESSES_PROVIDER`, `AAVE_PROTOCOL_DATA_PROVIDER`, `UI_POOL_DATA_PROVIDER`, `ASSETS.<SYM>.{UNDERLYING,A_TOKEN,V_TOKEN,decimals}`, and the ParaSwap adapters (`REPAY_WITH_COLLATERAL_ADAPTER`).
- Morpho: `https://api.morpho.org/graphql`. Supported chain ids include 1, 8453, 42161, 999 (HyperEVM), 4217 (Tempo), 4663 (Robinhood Chain).

## Aave v3 core calls (Pool)

- `supply(asset, amount, onBehalfOf, 0)`; native ETH goes through `WrappedTokenGatewayV3.depositETH`.
- `borrow(asset, amount, 2, 0, onBehalfOf)` (rate mode 2 = variable).
- `repay(asset, amount, 2, onBehalfOf)`; `withdraw(asset, amount, to)`.
- `getUserAccountData(user)` → `totalCollateralBase`, `totalDebtBase`, `availableBorrowsBase`, `currentLiquidationThreshold`, `ltv`, `healthFactor` (1e18 scale). Base currency is USD with 8 decimals.
- `flashLoanSimple(receiver, asset, amount, params, 0)`. The receiver implements `executeOperation(asset, amount, premium, initiator, params)` and approves `amount + premium` to the Pool.

Health factor = `collateral × liquidationThreshold / debt`. Liquidation starts below 1.0.

Worked case: supply 2 ETH at 4,000 USD, borrow at 60% LTV → debt 4,800 USDC. With a liquidation threshold of 0.83, HF = 8,000 × 0.83 / 4,800 = 1.38. The guard default trigger is 1.15.

## Aave v4

Verified against the official API on 2026-10-12. Live on Ethereum since 2026-03-30.

- Chains with Aave v4 on 2026-10-12: Ethereum (13 spokes, 75 reserves), Base (Coinbase Stocks spoke: tokenized stocks and USDC), Avalanche, Arc. `aave_v4_markets` returns the live chain list. Do not trust this line when the tool says different.
- Aave v4 is NOT on Arbitrum, Robinhood Chain, HyperEVM or Tempo. On those chains use Aave v3 (Arbitrum) or Morpho (Robinhood Chain, HyperEVM, Tempo). Say this plainly when a user asks for Aave v4 there.
- The agent can act on Ethereum and Base. It can read Avalanche and Arc, but it cannot send transactions there.
- Design: hubs hold the liquidity (Core, Plus, Prime). Spokes are the markets users act on (Main, Bluechip, Forex, Gold, Lido, Etherfi, Kelp, Lombard, Ethena, PAXG Gold, Pendle and more). A spoke draws liquidity from a hub inside a credit line.
- One token can be in several spokes. The rate, the collateral factor and the caps are different in each. Always name the spoke.
- A position belongs to one spoke. The health factor is separate for each spoke. Collateral in one spoke does not protect debt in another.
- Source of truth: the AaveKit GraphQL API at `https://api.aave.com/graphql`. It gives chains, reserves, positions and ready transactions. `PercentNumber.normalized` is the percent value (3.99 = 3.99%). The address book package has no v4 entries.
- Tools: `aave_v4_markets` (reserve ids, rates), `aave_v4_account` (positions for each spoke), `aave_v4_action` (supply, borrow, withdraw, repay).
- A reserve id from the API is a string. The on-chain id is a small number inside one spoke. Do not mix them.
- Native ETH goes through a gateway contract that the API selects. An ERC-20 needs an approval to the spoke first. The API adds it.
- The Aave v3 guard and the unwind contract do not work for v4. A v4 guard is a scheduled job (`job_schedule`).

### Who can act on an Aave v4 position (verified in `src/spoke/Spoke.sol`, repo `aave/aave-v4`, on 2026-10-12)

`supply`, `withdraw`, `borrow` and `repay` have the modifier `onlyPositionManager(onBehalfOf)`. The check is:

```solidity
function _isPositionManager(address user, address manager) internal view returns (bool) {
  if (user == manager) return true;                      // the user's own wallet is always allowed
  PositionManagerConfig storage config = _positionManager[manager];
  return config.active && config.approval[user];         // else: active by governance AND approved by the user
}
```

- A contract that you deploy is not an active position manager. It cannot repay or withdraw for a user by a direct call. Unlike Aave v3, a third party cannot repay the debt of a user.
- This does NOT stop an unwind. The wallet of the user is always allowed, and both wallets of this product make their own calls: the agent wallet through the gas sponsor, and the linked wallet through a permission (EIP-7702). In both cases `msg.sender` at the Spoke is the wallet of the user.
- So do not tell a user that an Aave v4 unwind is not possible. The working method, with no flash loan:
  1. Ask for a permission on the linked wallet: the Spoke (`withdraw`, `repay`), the collateral token and the debt token (`approve`), and the swap contract of the route.
  2. One round, as one batch from the wallet: withdraw the collateral that the health factor allows, swap it to the debt token, repay. Each round raises the health factor, so the next round can withdraw more. Three or four rounds close a position with a health factor near 1.3.
  3. To do it at a price or a health factor, store the rounds with `job_schedule`. Use Aave v4 steps for repay and withdraw so the amounts are current when the job fires.
- Close a whole Aave v4 position: use `aave_v4_unwind` now, or `job_schedule` with action type `aave_v4_unwind` to close it at a price or a health factor. The job reads the debt, the collateral and the swap route when it fires, so nothing goes stale. Do not refuse a scheduled unwind for lack of a call format.
- FlashExecutor facts (source verified on Sourcify on Ethereum, Base, Arbitrum and Robinhood Chain: `https://sourcify.dev/server/v2/contract/1/0x075cB7A716bD046bc169CCFc676629dA44AD5Cf1`; repo path `contracts/flash-executor/src/FlashExecutor.sol`):
  - Anyone can call `run`, but a step that uses a wallet permission needs that permission to contain an ArgsEqualityCheckEnforcer caveat. The executor writes `msg.sender` of `run` into its args, and the enforcer reverts unless it equals the starter named in the permission (the user's agent wallet). A permission without that caveat is refused by the executor. So a permission that becomes public on-chain is useless to anyone else. Tested on a fork: a run started by another address reverts with `ArgsEqualityCheckEnforcer:different-args-and-terms`.
  - The caller sets the recipient of what is left, but only the agent wallet can start a run that uses the user's permission, and the server sets the recipient to the same wallet.
  - A step from the executor cannot call transferFrom, Permit2 or the DelegationManager. The executor holds nothing between runs.
  - The real trust is the server: the agent wallet key is on the server, and a permission lets the agent wallet start runs within its functions until it ends. Ask for the smallest functions and a short end date.
- A flash-loan unwind in one transaction: use `flash_run` and the shared FlashExecutor. Do not write or deploy a contract for it.
  - The executor is one audited-by-us-only contract at the same address on Ethereum, Arbitrum, Base and Robinhood Chain (the tool error names it). It borrows from Morpho (no fee; Ethereum, Base) or Aave v3, runs the steps, repays the loan and sends what is left to the agent wallet.
  - Steps: `executor` (calls from the executor, for example send the loan to the wallet or swap), `agent` (the agent wallet acts; the server signs a one-hour permission for exactly those calls), `linked` (the user's own wallet acts; it needs an active permission with `delegate` = the executor, asked with `linked_wallet_request_permission`).
  - Unwind recipe (tested on a Base fork on 2026-10-12): executor sends the borrowed debt token to the wallet; wallet approves the Spoke or Pool and repays all; wallet withdraws the collateral with the executor as receiver; executor approves and swaps the collateral on an on-chain DEX route; the loan is repaid; the rest goes back. For a swap route from LI.FI use a plain DEX (`allowExchanges=sushiswap,kyberswap,1inch`). An RFQ route (nordstern) fails because its quote is signed for another state.
  - A wallet pays the executor with `transfer`. Never approve the executor: anyone can start a run.
  - Store the same `flash_run` plan with `job_schedule` (as fixed transactions) to unwind at a price.
- Aave's own position managers (NativeTokenGateway, SignatureGateway, Giver, Taker, Config) are in `src/position-manager`. The API query `spokePositionManagers` lists the active ones for a spoke.

## Unwind design (this product)

Contract source: `contracts/unwind`. The user grants the contract an aToken allowance. A keeper can call `unwind(user, ...)` only when the on-chain health factor is below the threshold that the user stored. The steps are:

1. `flashLoanSimple` of the debt asset.
2. `repay` the user's debt.
3. Pull aTokens with `transferFrom`, then `withdraw` the collateral.
4. Swap collateral to the debt asset through an allowlisted router with a minimum output.
5. Repay the flash loan plus premium. Send the rest to the user.

The threshold check is in the contract. The backend cannot unwind a healthy position. The user revokes with `approve(unwind, 0)` on the aToken.

Prefer Aave's `ParaSwapRepayAdapter` when a ParaSwap route exists. It needs the same aToken allowance.

## Rates

- Aave: `AaveProtocolDataProvider.getReserveData(asset)` → `liquidityRate` (ray, 1e27). APY ≈ `(1 + rate/1e27/31536000)^31536000 - 1`.
- Morpho: GraphQL `vaults` and `markets` with `state { apy netApy }`.
- Fast comparison: `https://yields.llama.fi/pools`.
