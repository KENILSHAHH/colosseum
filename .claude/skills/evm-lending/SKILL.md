---
name: evm-lending
description: Aave v3 and Morpho on Ethereum, Arbitrum, Base, Tempo and Robinhood Chain. Supply, borrow, health factor, flash-loan unwind, address sources. Use for lending rates, leveraged positions, health factor guards, or any Aave or Morpho question.
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
