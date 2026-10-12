// Relay bridge adapter. Docs: https://docs.relay.link/references/api/get-quote-v2
// Relay covers every chain of this product (GET https://api.relay.link/chains, checked 2026-10-11).
import { CHAINS, type ChainKey } from "../registry/chains";
import { getJson, postJson } from "./http";

const RELAY = "https://api.relay.link";

interface RelayCurrency { id?: string; symbol: string; name: string; address: string; decimals: number; supportsBridging?: boolean }
interface RelayChain { id: number; name: string; currency?: RelayCurrency; erc20Currencies?: RelayCurrency[]; featuredTokens?: RelayCurrency[]; solverCurrencies?: RelayCurrency[] }

let chainCache: { at: number; chains: RelayChain[] } | undefined;
async function relayChains() {
  if (!chainCache || Date.now() - chainCache.at > 600_000) {
    chainCache = { at: Date.now(), chains: (await getJson<{ chains: RelayChain[] }>(`${RELAY}/chains`)).chains };
  }
  return chainCache.chains;
}

/** Resolve a token symbol to the address that Relay lists for the chain. Addresses come from Relay, not from a model. */
export async function resolveCurrency(chain: ChainKey, symbol: string): Promise<RelayCurrency> {
  const chains = await relayChains();
  const c = chains.find((x) => x.id === CHAINS[chain].relayId);
  if (!c) throw new Error(`Relay does not list ${CHAINS[chain].name}.`);
  const all = [c.currency, ...(c.solverCurrencies ?? []), ...(c.erc20Currencies ?? []), ...(c.featuredTokens ?? [])].filter((x): x is RelayCurrency => !!x);
  const hit = all.find((x) => x.symbol.toUpperCase() === symbol.toUpperCase());
  if (!hit) {
    throw new Error(`Relay lists no "${symbol}" on ${CHAINS[chain].name}. Available: ${[...new Set(all.map((x) => x.symbol))].join(", ")}`);
  }
  return hit;
}

interface RelayQuote {
  steps: { id: string; action: string; description: string; kind: string; requestId?: string; items: { status: string; data: unknown }[] }[];
  fees: Record<string, { amountFormatted?: string; amountUsd?: string; currency?: { symbol: string } }>;
  details: {
    timeEstimate?: number;
    rate?: string;
    totalImpact?: { usd?: string; percent?: string };
    currencyIn?: { amountFormatted: string; amountUsd?: string; currency: { symbol: string } };
    currencyOut?: { amountFormatted: string; amountUsd?: string; currency: { symbol: string } };
  };
}

/** Placeholder senders for a quote with no connected wallet. Relay needs a syntactically valid address. */
const QUOTE_USER = { evm: "0x000000000000000000000000000000000000dEaD", svm: "CbKGgVKLJFb8bBrf58DnAkdryX6ubewVytn7X957YwNr" };

export async function quoteBridge(args: {
  fromChain: ChainKey; toChain: ChainKey; fromToken: string; toToken: string; amount: number; user?: string; recipient?: string;
}) {
  const [inCur, outCur] = await Promise.all([resolveCurrency(args.fromChain, args.fromToken), resolveCurrency(args.toChain, args.toToken)]);
  const from = CHAINS[args.fromChain];
  const to = CHAINS[args.toChain];
  const user = args.user ?? (from.vm === "svm" ? QUOTE_USER.svm : QUOTE_USER.evm);
  const recipient = args.recipient ?? (to.vm === from.vm ? user : to.vm === "svm" ? QUOTE_USER.svm : QUOTE_USER.evm);
  const quote = await postJson<RelayQuote>(`${RELAY}/quote`, {
    user, recipient,
    originChainId: from.relayId, destinationChainId: to.relayId,
    originCurrency: inCur.address, destinationCurrency: outCur.address,
    amount: BigInt(Math.round(args.amount * 10 ** inCur.decimals)).toString(),
    tradeType: "EXACT_INPUT",
  });
  // "relayer" is already the sum of "relayerGas" and "relayerService". Adding all entries counts it two times.
  const fee = (k: string) => Number((quote.fees as Record<string, { amountUsd?: string }> | undefined)?.[k]?.amountUsd ?? 0);
  const feeUsd = fee("gas") + fee("relayer") + fee("app");
  return {
    provider: "Relay",
    from: { chain: from.name, token: inCur.symbol, address: inCur.address, amount: args.amount },
    to: { chain: to.name, token: outCur.symbol, address: outCur.address, amount: Number(quote.details.currencyOut?.amountFormatted ?? 0) },
    etaSeconds: quote.details.timeEstimate ?? null,
    totalFeeUsd: feeUsd,
    impactPercent: quote.details.totalImpact?.percent ?? null,
    steps: quote.steps.map((s) => ({ id: s.id, kind: s.kind, action: s.action, description: s.description, requestId: s.requestId ?? null, transactions: s.items.map((i) => i.data) })),
    isExecutable: !!args.user,
    source: "https://api.relay.link/quote",
  };
}

export function bridgeStatus(requestId: string) {
  return getJson<{ status: string; txHashes?: string[]; inTxHashes?: string[] }>(`${RELAY}/intents/status/v3?requestId=${requestId}`);
}
