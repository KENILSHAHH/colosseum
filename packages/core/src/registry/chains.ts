import { config } from "../config";

export type ChainKey =
  | "ethereum"
  | "arbitrum"
  | "base"
  | "robinhood"
  | "tempo"
  | "hyperevm"
  | "hyperliquid"
  | "solana";

export interface ChainInfo {
  key: ChainKey;
  name: string;
  vm: "evm" | "hypercore" | "svm";
  chainId?: number;
  /** Chain id in the Relay API. Source: GET https://api.relay.link/chains (2026-10-11). */
  relayId: number;
  /** Chain name in https://yields.llama.fi/pools. */
  llamaName?: string;
  explorer: string;
  rpc: () => string;
  /** Bit position in the Solana policy account `allowed_chains` field. */
  policyBit: number;
  source: string;
}

export const CHAINS: Record<ChainKey, ChainInfo> = {
  ethereum: {
    key: "ethereum", name: "Ethereum", vm: "evm", chainId: 1, relayId: 1, llamaName: "Ethereum",
    explorer: "https://etherscan.io", rpc: () => config().RPC_ETHEREUM, policyBit: 0,
    source: "https://chainid.network/",
  },
  arbitrum: {
    key: "arbitrum", name: "Arbitrum One", vm: "evm", chainId: 42161, relayId: 42161, llamaName: "Arbitrum",
    explorer: "https://arbiscan.io", rpc: () => config().RPC_ARBITRUM, policyBit: 1,
    source: "https://docs.arbitrum.io/build-decentralized-apps/reference/node-providers",
  },
  base: {
    key: "base", name: "Base", vm: "evm", chainId: 8453, relayId: 8453, llamaName: "Base",
    explorer: "https://basescan.org", rpc: () => config().RPC_BASE, policyBit: 2,
    source: "https://docs.base.org/base-chain/quickstart/connecting-to-base",
  },
  robinhood: {
    key: "robinhood", name: "Robinhood Chain", vm: "evm", chainId: 4663, relayId: 4663, llamaName: "Robinhood Chain",
    explorer: "https://robinhoodchain.blockscout.com", rpc: () => config().RPC_ROBINHOOD, policyBit: 3,
    source: "https://docs.robinhood.com/chain/connecting",
  },
  tempo: {
    key: "tempo", name: "Tempo", vm: "evm", chainId: 4217, relayId: 4217, llamaName: "Tempo",
    explorer: "https://explore.tempo.xyz", rpc: () => config().RPC_TEMPO, policyBit: 4,
    source: "https://tempo.xyz/developers/docs/quickstart/connection-details",
  },
  hyperevm: {
    key: "hyperevm", name: "HyperEVM", vm: "evm", chainId: 999, relayId: 999, llamaName: "Hyperliquid L1",
    explorer: "https://hyperevmscan.io", rpc: () => config().RPC_HYPEREVM, policyBit: 5,
    source: "https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm",
  },
  hyperliquid: {
    key: "hyperliquid", name: "Hyperliquid (HyperCore)", vm: "hypercore", relayId: 1337,
    explorer: "https://app.hyperliquid.xyz/explorer", rpc: () => "https://api.hyperliquid.xyz", policyBit: 6,
    source: "https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api",
  },
  solana: {
    key: "solana", name: "Solana", vm: "svm", relayId: 792703809, llamaName: "Solana",
    explorer: "https://solscan.io", rpc: () => config().RPC_SOLANA, policyBit: 7,
    source: "https://solana.com/docs/references/clusters",
  },
};

export const CHAIN_KEYS = Object.keys(CHAINS) as [ChainKey, ...ChainKey[]];

/**
 * Canonical USDC per chain. Sources:
 * - Circle: https://developers.circle.com/stablecoins/usdc-contract-addresses
 * - Aave address book (`AaveV3*.ASSETS.USDC.UNDERLYING`) matches the three EVM entries.
 * Tempo and Robinhood Chain have no entry here. Resolve their stablecoins through a Relay quote.
 */
export const USDC: Partial<Record<ChainKey, { address: string; decimals: number }>> = {
  ethereum: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
  arbitrum: { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6 },
  base: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
  solana: { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 },
};
