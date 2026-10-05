// MPP on Tempo mainnet. Docs: https://mpp.dev/quickstart/server and https://mpp.dev/payment-methods/tempo/charge
// Each prompt costs one flat charge in OUSD. The payer is the agent wallet of the user.
// The API holds the agent wallet key, so the API is also the MPP client: it calls its own paid route,
// gets the 402 challenge, signs one TIP-20 transfer and tries again. The paid route broadcasts the transfer.
import { Mppx as MppClient, tempo as tempoClient } from "mppx/client";
import { Mppx, tempo } from "mppx/server";
import { erc20Abi, formatUnits, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config, publicClient, walletAccount } from "@app/core";

/** OUSD (OpenUSD) on Tempo, 6 decimals. Source: https://mpp.dev/quickstart/server */
export const OUSD = "0x20c0000000000000000000006a37DA5C996874BE" as const;
export const TEMPO_CHAIN_ID = 4217;
const OUSD_DECIMALS = 6;

export const mppEnabled = () => config().MPP_ENABLED === "true";

/** The address that receives the payments. */
export function mppRecipient(): Address {
  const c = config();
  if (c.MPP_RECIPIENT) return c.MPP_RECIPIENT as Address;
  if (c.MPP_SERVER_PRIVATE_KEY) return privateKeyToAccount(c.MPP_SERVER_PRIVATE_KEY as `0x${string}`).address;
  throw new Error("MPP is enabled. Set MPP_RECIPIENT or MPP_SERVER_PRIVATE_KEY.");
}

const tempoClients = () => publicClient("tempo");

function create() {
  const c = config();
  if (!c.MPP_SECRET_KEY) throw new Error("MPP is enabled. Set MPP_SECRET_KEY.");
  return Mppx.create({
    secretKey: c.MPP_SECRET_KEY,
    // The replay store is in memory. That is correct for one API process.
    methods: [tempo.charge({ currencies: [OUSD], recipient: mppRecipient(), testnet: false, getClient: tempoClients })],
  });
}

let instance: ReturnType<typeof create> | undefined;
export function mpp() {
  instance ??= create();
  return instance;
}

/** A fetch that pays a 402 challenge from the agent wallet of the user. It pays this server only, on Tempo mainnet only. */
export async function agentWalletFetch(userId: string): Promise<typeof fetch> {
  const account = await walletAccount(userId);
  const client = MppClient.create({
    polyfill: false,
    methods: [tempoClient.charge({ account, expectedChainId: TEMPO_CHAIN_ID, expectedRecipients: [mppRecipient()], getClient: tempoClients })],
  });
  return client.fetch as typeof fetch;
}

/** OUSD balance on Tempo. `null` means the RPC did not answer. */
export async function ousdBalance(address: string): Promise<number | null> {
  try {
    const raw = await publicClient("tempo").readContract({ address: OUSD, abi: erc20Abi, functionName: "balanceOf", args: [address as Address] });
    return Number(formatUnits(raw, OUSD_DECIMALS));
  } catch {
    return null;
  }
}
