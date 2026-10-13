// Fetches the current prices for the Trade tab and saves them in lib/demo-quotes.json.
// Run it before a recording: node scripts/fetch-demo-quotes.mjs
import { writeFileSync } from "node:fs";

const COINS = ["BTC", "ETH", "SOL", "HYPE"];
const STOCKS = ["TSLA", "AAPL", "NVDA", "GOOGL", "META", "NFLX", "COIN"];
// Aave v3 Ethereum market. The Aave API calls Ether "WETH".
const LEND = { ETH: "WETH", USDC: "USDC", USDT: "USDT", DAI: "DAI", BTC: "WBTC" };
// No public market exists for the 2030 World Cup. Set these by hand from the World app.
const PREDICTIONS = { spain: 0.17, france: 0.15, brazil: 0.09, argentina: 0.12, germany: 0.08, england: 0.13, portugal: 0.07, usa: 0.03, italy: 0.05, netherlands: 0.05 };

const json = async (url, init) => {
  const res = await fetch(url, { ...init, headers: { "user-agent": "Mozilla/5.0", "content-type": "application/json", ...init?.headers } });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
};

const hl = (body) => json("https://api.hyperliquid.xyz/info", { method: "POST", body: JSON.stringify(body) });
const [mids, meta] = await Promise.all([hl({ type: "allMids" }), hl({ type: "meta" })]);
const coins = Object.fromEntries(
  COINS.map((c) => [c, { price: Number(mids[c]), maxLeverage: meta.universe.find((u) => u.name === c).maxLeverage }]),
);

const stocks = Object.fromEntries(
  await Promise.all(
    STOCKS.map(async (s) => {
      const d = await json(`https://query1.finance.yahoo.com/v8/finance/chart/${s}?range=1d&interval=1d`);
      return [s, { price: d.chart.result[0].meta.regularMarketPrice }];
    }),
  ),
);

const aave = await json("https://api.v3.aave.com/graphql", {
  method: "POST",
  body: JSON.stringify({ query: "{ markets(request:{chainIds:[1]}){ name reserves{ underlyingToken{symbol} supplyInfo{apy{formatted}} } } }" }),
});
const market = aave.data.markets.find((m) => m.name === "AaveV3Ethereum");
const lending = Object.fromEntries(
  Object.entries(LEND).map(([symbol, aaveSymbol]) => [symbol, { apy: Number(market.reserves.find((r) => r.underlyingToken.symbol === aaveSymbol).supplyInfo.apy.formatted) }]),
);

// The "Bitcoin Up or Down" markets of the current 5 and 15 minute windows. The price to buy Up is the best ask. The price to buy Down is one minus the best bid of Up.
const updown = Object.fromEntries(
  await Promise.all(
    [5, 15].map(async (minutes) => {
      const start = Math.floor(Date.now() / 1000 / (minutes * 60)) * minutes * 60;
      const [event] = await json(`https://gamma-api.polymarket.com/events?slug=btc-updown-${minutes}m-${start}`);
      const m = event.markets[0];
      return [String(minutes), { up: Number(m.bestAsk), down: Number((1 - Number(m.bestBid)).toFixed(3)) }];
    }),
  ),
);

// Jupiter Lend on Solana. The rate is in basis points: 391 is 3.91%.
const jup = await json("https://lite-api.jup.ag/lend/v1/earn/tokens");
const jupiterLend = Object.fromEntries(
  ["SOL", "USDC"].map((symbol) => [symbol, { apy: Number(jup.find((t) => t.asset.uiSymbol === symbol).totalRate) / 100 }]),
);

const out = { fetchedAt: new Date().toISOString(), coins, stocks, lending, predictions: PREDICTIONS, updown, jupiterLend };
writeFileSync(new URL("../lib/demo-quotes.json", import.meta.url), `${JSON.stringify(out, null, 2)}\n`);
console.log(out);
