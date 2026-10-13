import { erc20Abi, encodeFunctionData } from "viem";
import * as evm from "./adapters/evm";
import { HL_BRIDGE_ARBITRUM, HL_MIN_DEPOSIT_USDC } from "./adapters/hyperliquid";
import { sendTransactions } from "./executors/evm";
import { USDC } from "./registry/chains";
import { getOrCreateWallet } from "./wallet";

/**
 * Move the USDC that waits on Arbitrum in the Hyperliquid account of the user into Hyperliquid through the official bridge.
 * A deposit from an own wallet sends USDC on Arbitrum to that account first. The gas sponsor pays.
 */
export async function creditHyperliquid(userId: string) {
  const { hlAddress } = await getOrCreateWallet(userId);
  const usdc = USDC.arbitrum!.address as `0x${string}`;
  const held = await evm.evmClient("arbitrum").readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [hlAddress] });
  if (held < BigInt(HL_MIN_DEPOSIT_USDC * 1e6)) throw new Error(`Hyperliquid takes at least ${HL_MIN_DEPOSIT_USDC} USDC. The account holds ${Number(held) / 1e6} USDC on Arbitrum.`);
  const receipts = await sendTransactions(userId, "arbitrum", [{ to: usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [HL_BRIDGE_ARBITRUM, held] }), value: "0", description: "Deposit to Hyperliquid" }], { legacy: true });
  return { usdc: Number(held) / 1e6, hyperliquidAccount: hlAddress, receipts };
}
