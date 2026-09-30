// Aave v3 adapter. Addresses come from the official address book package
// (https://github.com/bgd-labs/aave-address-book). Pool interface:
// https://github.com/aave-dao/aave-v3-origin/blob/main/src/contracts/interfaces/IPool.sol
import { createPublicClient, encodeFunctionData, http, parseAbi, parseUnits, type Address } from "viem";
import { AaveV3Arbitrum, AaveV3Base, AaveV3Ethereum } from "@bgd-labs/aave-address-book";
import { CHAINS, type ChainKey } from "../registry/chains";

export type AaveChain = "ethereum" | "arbitrum" | "base";
const BOOKS = { ethereum: AaveV3Ethereum, arbitrum: AaveV3Arbitrum, base: AaveV3Base } as const;

export const poolAbi = parseAbi([
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
  "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)",
  "function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)",
  "function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) returns (uint256)",
  "function withdraw(address asset, uint256 amount, address to) returns (uint256)",
]);
const gatewayAbi = parseAbi(["function depositETH(address pool, address onBehalfOf, uint16 referralCode) payable"]);
const oracleAbi = parseAbi(["function getAssetPrice(address asset) view returns (uint256)"]);
const dataProviderAbi = parseAbi([
  "function getReserveConfigurationData(address asset) view returns (uint256 decimals, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, uint256 reserveFactor, bool usageAsCollateralEnabled, bool borrowingEnabled, bool stableBorrowRateEnabled, bool isActive, bool isFrozen)",
]);
const erc20Abi = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);

export function aaveBook(chain: AaveChain) {
  return BOOKS[chain];
}

function client(chain: ChainKey) {
  return createPublicClient({ transport: http(CHAINS[chain].rpc()) });
}

function asset(chain: AaveChain, symbol: string) {
  const sym = symbol.toUpperCase() === "ETH" ? "WETH" : symbol.toUpperCase();
  const a = (BOOKS[chain].ASSETS as Record<string, { UNDERLYING: Address; A_TOKEN: Address; V_TOKEN: Address; decimals: number }>)[sym];
  if (!a) throw new Error(`Aave v3 on ${chain} lists no asset "${symbol}".`);
  return { symbol: sym, ...a };
}

/** Base currency of Aave v3 is USD with 8 decimals. Health factor has 18 decimals. */
export async function getAccount(chain: AaveChain, user: Address) {
  const d = await client(chain).readContract({ address: BOOKS[chain].POOL, abi: poolAbi, functionName: "getUserAccountData", args: [user] });
  const debt = Number(d[1]) / 1e8;
  return {
    chain: CHAINS[chain].name,
    user,
    collateralUsd: Number(d[0]) / 1e8,
    debtUsd: debt,
    availableBorrowsUsd: Number(d[2]) / 1e8,
    liquidationThreshold: Number(d[3]) / 1e4,
    ltv: Number(d[4]) / 1e4,
    healthFactor: debt === 0 ? null : Number(d[5]) / 1e18,
    source: `${CHAINS[chain].explorer}/address/${BOOKS[chain].POOL}`,
  };
}

export interface TxRequest { chainId: number; to: Address; data: `0x${string}`; value: string; description: string }

/**
 * Preview "supply collateral, then borrow at a target LTV".
 * All numbers come from the on-chain oracle and reserve configuration.
 */
export async function previewSupplyBorrow(args: {
  chain: AaveChain; user: Address; collateral: string; collateralAmount: number; borrow: string; targetLtv: number;
}) {
  const book = BOOKS[args.chain];
  const c = client(args.chain);
  const col = asset(args.chain, args.collateral);
  const debt = asset(args.chain, args.borrow);
  const isNative = args.collateral.toUpperCase() === "ETH";

  const [colPrice, debtPrice, colCfg, account] = await Promise.all([
    c.readContract({ address: book.ORACLE, abi: oracleAbi, functionName: "getAssetPrice", args: [col.UNDERLYING] }),
    c.readContract({ address: book.ORACLE, abi: oracleAbi, functionName: "getAssetPrice", args: [debt.UNDERLYING] }),
    c.readContract({ address: book.AAVE_PROTOCOL_DATA_PROVIDER, abi: dataProviderAbi, functionName: "getReserveConfigurationData", args: [col.UNDERLYING] }),
    getAccount(args.chain, args.user),
  ]);
  const maxLtv = Number(colCfg[1]) / 1e4;
  const liqThreshold = Number(colCfg[2]) / 1e4;
  if (!colCfg[5]) throw new Error(`${col.symbol} cannot be used as collateral on Aave v3 ${args.chain}.`);
  if (colCfg[9]) throw new Error(`${col.symbol} reserve is frozen on Aave v3 ${args.chain}.`);
  if (args.targetLtv > maxLtv) throw new Error(`Target LTV ${(args.targetLtv * 100).toFixed(0)}% is above the maximum ${(maxLtv * 100).toFixed(0)}% for ${col.symbol}.`);

  const colUsd = (Number(colPrice) / 1e8) * args.collateralAmount;
  const borrowUsd = colUsd * args.targetLtv;
  const borrowAmount = borrowUsd / (Number(debtPrice) / 1e8);
  const totalCol = account.collateralUsd + colUsd;
  const totalDebt = account.debtUsd + borrowUsd;
  // Weighted threshold: existing collateral keeps its current threshold.
  const weightedThreshold = totalCol === 0 ? 0 : (account.collateralUsd * account.liquidationThreshold + colUsd * liqThreshold) / totalCol;
  const healthFactor = (totalCol * weightedThreshold) / totalDebt;
  // Collateral price at which HF reaches 1, when only the new collateral price moves.
  const liquidationPrice = totalDebt / (args.collateralAmount * liqThreshold) - (account.collateralUsd * account.liquidationThreshold) / (args.collateralAmount * liqThreshold);

  const colRaw = parseUnits(args.collateralAmount.toString(), col.decimals);
  const borrowRaw = parseUnits(borrowAmount.toFixed(debt.decimals), debt.decimals);
  const chainId = CHAINS[args.chain].chainId!;
  const txs: TxRequest[] = [];
  if (isNative) {
    txs.push({ chainId, to: book.WETH_GATEWAY, value: colRaw.toString(), description: `Supply ${args.collateralAmount} ETH to Aave v3`,
      data: encodeFunctionData({ abi: gatewayAbi, functionName: "depositETH", args: [book.POOL, args.user, 0] }) });
  } else {
    txs.push({ chainId, to: col.UNDERLYING, value: "0", description: `Approve ${args.collateralAmount} ${col.symbol} for the Aave Pool`,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [book.POOL, colRaw] }) });
    txs.push({ chainId, to: book.POOL, value: "0", description: `Supply ${args.collateralAmount} ${col.symbol} to Aave v3`,
      data: encodeFunctionData({ abi: poolAbi, functionName: "supply", args: [col.UNDERLYING, colRaw, args.user, 0] }) });
  }
  txs.push({ chainId, to: book.POOL, value: "0", description: `Borrow ${borrowAmount.toFixed(2)} ${debt.symbol} at variable rate`,
    data: encodeFunctionData({ abi: poolAbi, functionName: "borrow", args: [debt.UNDERLYING, borrowRaw, 2n, 0, args.user] }) });

  return {
    chain: CHAINS[args.chain].name,
    collateral: { symbol: args.collateral.toUpperCase(), amount: args.collateralAmount, priceUsd: Number(colPrice) / 1e8, valueUsd: colUsd, aToken: col.A_TOKEN },
    borrow: { symbol: debt.symbol, amount: borrowAmount, valueUsd: borrowUsd },
    targetLtv: args.targetLtv, maxLtv, liquidationThreshold: liqThreshold,
    healthFactorAfter: healthFactor,
    collateralLiquidationPriceUsd: Math.max(0, liquidationPrice),
    existing: { collateralUsd: account.collateralUsd, debtUsd: account.debtUsd, healthFactor: account.healthFactor },
    transactions: txs,
    addresses: { pool: book.POOL, oracle: book.ORACLE, source: "@bgd-labs/aave-address-book" },
  };
}
