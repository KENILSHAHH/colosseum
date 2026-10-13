"use client";

import { ArrowUp, Check, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import quotes from "@/lib/demo-quotes.json";

/** The tab has no server. It reads the words of the user and shows a card for each action, as if the order was filled. The prices come from lib/demo-quotes.json (see scripts/fetch-demo-quotes.mjs). */

interface Logo { label: string; src?: string; tile?: boolean; fill?: boolean }
interface DemoCard { logos: Logo[]; venue: Logo; title: string; note?: string; steps: string[]; facts: [string, string][] }
// "done" is the number of finished steps. The step after it is the one that runs.
interface Entry { role: "user" | "assistant"; text?: string; cards?: DemoCard[]; steps?: string[]; done?: number; pending?: boolean }

/** The steps run for about two seconds. The card shows after the last step. */
const STEPS_MS = 2000;

const VENUES = {
  robinhood: { label: "Robinhood", src: "/icons/robinhood.svg", tile: true },
  hyperliquid: { label: "Hyperliquid", src: "/icons/hyperliquid.webp" },
  aave: { label: "Aave", src: "/icons/aave.webp" },
  jupiter: { label: "Jupiter", src: "/icons/jupiter.png" },
  world: { label: "World", src: "/icons/world.png" },
} satisfies Record<string, Logo>;

const TOKENS: Record<string, Logo> = {
  BTC: { label: "Bitcoin", src: "/icons/btc.png" },
  ETH: { label: "Ethereum", src: "/icons/eth.png" },
  SOL: { label: "Solana", src: "/icons/chain-solana.svg" },
  HYPE: { label: "Hyperliquid", src: "/icons/hyperliquid.webp" },
  USDC: { label: "USDC", src: "/icons/usdc.png" },
  USDT: { label: "USDT", src: "/icons/usdt.png" },
  DAI: { label: "DAI", src: "/icons/dai.png" },
};
const COINS: Record<string, { price: number; maxLeverage: number }> = quotes.coins;
const STABLES = ["USDC", "USDT", "DAI"];
const LENDING: Record<string, Record<string, { apy: number }>> = quotes.lending;
const CHAINS: Record<string, Logo> = {
  ethereum: { label: "Ethereum", src: "/icons/chain-ethereum.png" },
  base: { label: "Base", src: "/icons/chain-base.png" },
  arbitrum: { label: "Arbitrum", src: "/icons/chain-arbitrum.png" },
};
const STOCK_PRICES: Record<string, { price: number }> = quotes.stocks;
const PREDICTIONS: Record<string, number> = quotes.predictions;

const STOCKS: Record<string, { name: string; logo: Logo }> = {
  TSLA: { name: "tesla", logo: { label: "Tesla", src: "/icons/tesla.svg", tile: true } },
  AAPL: { name: "apple", logo: { label: "Apple", src: "/icons/apple.svg", tile: true } },
  NVDA: { name: "nvidia", logo: { label: "Nvidia", src: "/icons/nvidia.svg", tile: true } },
  GOOGL: { name: "google", logo: { label: "Google", src: "/icons/google.svg", tile: true } },
  META: { name: "meta", logo: { label: "Meta", src: "/icons/meta.svg", tile: true } },
  NFLX: { name: "netflix", logo: { label: "Netflix", src: "/icons/netflix.svg", tile: true } },
  COIN: { name: "coinbase", logo: { label: "Coinbase", src: "/icons/coinbase.svg", tile: true } },
};

const COUNTRIES: Record<string, { name: string; code: string }> = {
  spain: { name: "Spain", code: "es" },
  france: { name: "France", code: "fr" },
  brazil: { name: "Brazil", code: "br" },
  argentina: { name: "Argentina", code: "ar" },
  germany: { name: "Germany", code: "de" },
  england: { name: "England", code: "gb-eng" },
  portugal: { name: "Portugal", code: "pt" },
  usa: { name: "USA", code: "us" },
  italy: { name: "Italy", code: "it" },
  netherlands: { name: "Netherlands", code: "nl" },
  japan: { name: "Japan", code: "jp" },
  mexico: { name: "Mexico", code: "mx" },
  croatia: { name: "Croatia", code: "hr" },
  morocco: { name: "Morocco", code: "ma" },
  colombia: { name: "Colombia", code: "co" },
  uruguay: { name: "Uruguay", code: "uy" },
  belgium: { name: "Belgium", code: "be" },
  canada: { name: "Canada", code: "ca" },
  korea: { name: "South Korea", code: "kr" },
  australia: { name: "Australia", code: "au" },
};

const money = (v: number, d = 2) => `$${v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const amount = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 6 });
const has = (text: string, re: RegExp) => re.test(text);

function token(text: string): [string, Logo] | null {
  return Object.entries(TOKENS).find(([symbol]) => has(text, new RegExp(`\\b${symbol}\\b`, "i"))) ?? null;
}

const priceOf = (symbol: string) => COINS[symbol]?.price ?? (STABLES.includes(symbol) ? 1 : null);

/** One action in, one card out. It returns null when the words are not an action that the tab knows. */
function toCard(raw: string): DemoCard | null {
  const text = raw.toLowerCase();
  const number = (re: RegExp) => { const m = text.match(re); return m ? Number(m[1]) : null; };

  // "Up or Down" on World for BTC, ETH or SOL, for a window of 5 or 15 minutes. The window is the one that runs now.
  const asset = text.match(/\b(btc|bitcoin|eth|ethereum|sol|solana)\b/)?.[1];
  if (asset && has(text, /\b(up|down)\b/)) {
    const symbol = asset.startsWith("b") ? "BTC" : asset.startsWith("e") ? "ETH" : "SOL";
    const asked = number(/(\d+)\s*-?\s*(?:m|mins?|minutes?)\b/);
    const minutes = asked === 15 ? 15 : 5;
    const market = (quotes.updown as Record<string, Record<string, { up: number; down: number }>>)[symbol.toLowerCase()]?.[String(minutes)];
    if (!market) return null;
    const side = has(text, /\bdown\b/) && !has(text, /\bup\b/) ? "Down" : "Up";
    const price = side === "Up" ? market.up : market.down;
    const shares = number(/(\d+(?:\.\d+)?)\s*(?:shares?|x)\b/) ?? 1;
    const start = Math.floor(Date.now() / (minutes * 60_000)) * minutes * 60_000;
    const clock = (t: number) => new Date(t).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).replace(" AM", "").replace(" PM", "");
    const zone = new Date(start).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric" }).slice(-2);
    return {
      logos: [TOKENS[symbol]!],
      venue: VENUES.world,
      title: `Bought ${side.toUpperCase()} · ${symbol}`,
      note: `${minutes} min · ${clock(start)}–${clock(start + minutes * 60_000)} ${zone} ET`,
      steps: ["Reading the World market", `Getting the ${symbol} ${side} price`, `Buying ${amount(shares)} ${side.toUpperCase()} ${shares === 1 ? "share" : "shares"}`, "Order filled"],
      facts: [["Price", `${Math.round(price * 100)}¢`], ["Shares", amount(shares)], ["Cost", money(shares * price)]],
    };
  }

  // Prediction market on World.
  if (has(text, /\b(world|fifa|predict|bet|winning|wins?)\b/) && !has(text, /\b(robinhood|hyperliquid|aave)\b/)) {
    const side = has(text, /\bno\b/) && !has(text, /\byes\b/) ? "NO" : "YES";
    const hit = Object.entries(COUNTRIES).find(([key]) => has(text, new RegExp(`\\b${key}\\b`)));
    const yes = hit ? PREDICTIONS[hit[0]] : undefined;
    if (!hit || !yes) return null;
    const country = hit[1];
    const price = side === "YES" ? yes : 1 - yes;
    // "5 yes" or "5 shares" is a number of shares. "$20" is an amount to spend. With neither, the amount is $10.
    const asked = number(/(\d+(?:\.\d+)?)\s*(?:yes|no|shares?)\b/);
    const shares = asked ?? Math.round((((number(/\$\s*(\d+(?:\.\d+)?)/) ?? 10) / price) * 10)) / 10;
    const cost = shares * price;
    const logos: Logo[] = [{ label: country.name, src: `/icons/flag-${country.code}.png`, fill: true }];
    if (has(text, /fifa|world cup/)) logos.push({ label: "FIFA", src: "/icons/fifa.svg", tile: true });
    return {
      logos,
      venue: VENUES.world,
      title: `Bought ${side} · ${country.name}`,
      note: "FIFA World Cup 2030",
      steps: ["Reading the World market", `Getting the ${side} price for ${country.name}`, `Buying ${amount(shares)} ${side} shares`, "Order filled"],
      facts: [["Price", `${Math.round(price * 100)}¢`], ["Shares", amount(shares)], ["Cost", money(cost)]],
    };
  }

  // Stock on Robinhood.
  const stock = Object.entries(STOCKS).find(([symbol, s]) => has(text, new RegExp(`\\b(${symbol.toLowerCase()}|${s.name})\\b`)));
  if (stock) {
    const [symbol, info] = stock;
    const qty = number(/(\d+(?:\.\d+)?)/) ?? 1;
    const price = STOCK_PRICES[symbol]!.price;
    return {
      logos: [info.logo],
      venue: VENUES.robinhood,
      title: `Bought ${amount(qty)} ${symbol}`,
      steps: ["Reading the Robinhood account", `Getting the ${symbol} price`, `Placing a market order for ${amount(qty)} ${symbol}`, "Order filled"],
      facts: [["Price", money(price)], ["Total", money(qty * price)]],
    };
  }

  // Perpetual on Hyperliquid.
  const leverage = number(/(\d+)\s*x\b/);
  const side = text.match(/\b(long|short)\b/)?.[1];
  if (leverage || side) {
    const [symbol, logo] = token(text) ?? ["BTC", TOKENS.BTC!];
    const coin = COINS[symbol];
    if (!coin) return null;
    // The size is the number before the coin or before "long" or "short".
    const size = number(new RegExp(`(\\d*\\.?\\d+)\\s*(?:${symbol}|long|short)\\b`, "i")) ?? 0.01;
    const lev = Math.min(leverage ?? 10, coin.maxLeverage);
    const long = side !== "short";
    // The liquidation price follows the Hyperliquid rule for isolated margin: the maintenance margin is half of the margin at maximum leverage.
    const mm = 1 / (2 * coin.maxLeverage);
    const liq = long ? coin.price * (1 - 1 / (lev * (1 - mm))) : coin.price * (1 + 1 / (lev * (1 + mm)));
    return {
      logos: [logo],
      venue: VENUES.hyperliquid,
      title: `${long ? "Long" : "Short"} ${lev}x · ${amount(size)} ${symbol}`,
      steps: ["Reading the Hyperliquid account", `Setting ${lev}x leverage on ${symbol}`, `Opening a ${long ? "long" : "short"} of ${amount(size)} ${symbol}`, "Order filled"],
      facts: [["Entry", money(coin.price)], ["Margin", money((size * coin.price) / lev)], ["Liq.", money(liq)]],
    };
  }

  // Lending on Jupiter Lend (Solana).
  if (has(text, /\b(jupiter|jup)\b/) && has(text, /\b(lend|lent|lending|supply|supplied|deposit)\b/)) {
    const [symbol, logo] = token(text) ?? ["SOL", TOKENS.SOL!];
    const price = priceOf(symbol);
    const rate = (quotes.jupiterLend as Record<string, { apy: number }>)[symbol];
    if (price === null || !rate) return null;
    const qty = number(/(\d+(?:\.\d+)?)/) ?? 1;
    return {
      logos: [logo],
      venue: VENUES.jupiter,
      title: `Lent ${amount(qty)} ${symbol}`,
      steps: ["Reading the Jupiter Lend market", `Depositing ${amount(qty)} ${symbol}`, "Signing the transaction", "Deposit confirmed"],
      facts: [["APY", `${rate.apy.toFixed(2)}%`], ["Value", money(qty * price)]],
    };
  }

  // Lending on Aave. The chain is Ethereum when the words name none.
  if (has(text, /\b(aave|lend|lent|lending|supply|supplied)\b/)) {
    const [symbol, logo] = token(text) ?? ["ETH", TOKENS.ETH!];
    const chain = Object.keys(CHAINS).find((c) => has(text, new RegExp(`\\b${c}\\b`))) ?? "ethereum";
    const price = priceOf(symbol);
    const rate = LENDING[chain]?.[symbol];
    if (price === null || !rate) return null;
    const qty = number(/(\d+(?:\.\d+)?)/) ?? 1;
    return {
      logos: [logo, CHAINS[chain]!],
      venue: VENUES.aave,
      title: `Lent ${amount(qty)} ${symbol}`,
      note: CHAINS[chain]!.label,
      steps: [`Reading the Aave market on ${CHAINS[chain]!.label}`, `Approving ${symbol}`, `Supplying ${amount(qty)} ${symbol}`, "Supply confirmed"],
      facts: [["APY", `${rate.apy.toFixed(2)}%`], ["Value", money(qty * price)]],
    };
  }

  // Spot buy on Hyperliquid.
  if (has(text, /\bhyperliquid\b/)) {
    const [symbol, logo] = token(text) ?? ["ETH", TOKENS.ETH!];
    const price = priceOf(symbol);
    if (price === null) return null;
    const qty = number(/(\d*\.?\d+)\s*[a-z]/) ?? 1;
    return {
      logos: [logo],
      venue: VENUES.hyperliquid,
      title: `Bought ${amount(qty)} ${symbol}`,
      steps: ["Reading the Hyperliquid account", `Getting the ${symbol} price`, `Buying ${amount(qty)} ${symbol}`, "Order filled"],
      facts: [["Price", money(price)], ["Total", money(qty * price)]],
    };
  }
  return null;
}

/** One message can hold more than one action. A new line, a semicolon, "then" or "and" splits it. */
function toCards(prompt: string): DemoCard[] {
  return prompt
    .split(/[\n;]+|\s+(?:then|and then|and)\s+(?=(?:buy|bought|lend|lent|open|long|short|supply|bet)\b)/i)
    .map((part) => toCard(part.trim()))
    .filter((c): c is DemoCard => c !== null);
}

function LogoImage({ logo, className }: { logo: Logo; className: string }) {
  return logo.src ? (
    <img src={logo.src} alt={logo.label} title={logo.label} className={`${className} rounded-full ${logo.fill ? "object-cover" : "object-contain"} ${logo.tile ? "bg-white p-[16%]" : ""}`} />
  ) : (
    <span title={logo.label} className={`${className} grid place-items-center rounded-full bg-raised text-[11px] text-dim`}>{logo.label.slice(0, 2)}</span>
  );
}

function Card({ card, delay }: { card: DemoCard; delay: number }) {
  return (
    <div style={{ animationDelay: `${delay}s`, animationFillMode: "both" }} className="step-in mb-3 w-full max-w-[460px] rounded-2xl border border-line bg-panel p-4">
      <div className="flex items-center gap-3">
        <div className="relative flex shrink-0 -space-x-2">
          {card.logos.map((logo) => <LogoImage key={logo.label} logo={logo} className="size-10 ring-2 ring-panel" />)}
          <LogoImage logo={card.venue} className="absolute -bottom-2 -right-2.5 size-6 ring-2 ring-panel" />
        </div>
        <div className="min-w-0 flex-1 pl-1">
          <div className="truncate text-[16px] leading-tight">{card.title}</div>
          <div className="truncate text-[12.5px] text-dim">on {card.venue.label}{card.note && ` · ${card.note}`}</div>
        </div>
        <span className="flex shrink-0 items-center gap-1 rounded-full bg-good/15 px-2 py-1 text-[11.5px] text-good">
          <Check className="size-3" /> Filled
        </span>
      </div>
      <div className="mt-3 flex gap-6 border-t border-line pt-3">
        {card.facts.map(([label, value]) => (
          <div key={label}>
            <div className="text-[11px] uppercase tracking-wider text-faint">{label}</div>
            <div className="font-mono text-[13px] tabular-nums">{value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function DemoChat({ active }: { active: boolean }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState("");
  const timers = useRef<number[]>([]);
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => () => { timers.current.forEach((t) => clearTimeout(t)); }, []);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [entries]);

  const send = (text: string) => {
    const prompt = text.trim();
    // One answer at a time, so that each answer lands under its own message.
    if (!prompt || entries.at(-1)?.pending) return;
    setInput("");
    const cards = toCards(prompt);
    // Several actions share the time. Each one gives its first steps, and the last step of the message is the fill.
    const steps = cards.length === 1 ? cards[0]!.steps : cards.flatMap((c) => c.steps.slice(1, 3)).concat("Orders filled");
    setEntries((e) => [...e, { role: "user", text: prompt }, { role: "assistant", pending: true, ...(cards.length ? { steps, done: 0 } : {}) }]);
    const after = (ms: number, fn: () => void) => timers.current.push(window.setTimeout(fn, ms));
    if (!cards.length) return after(800, () => setEntries((e) => [...e.slice(0, -1), { role: "assistant", text: "I did not find an action in your message." }]));
    // A step ends every STEPS_MS / steps. The card shows when the last step ends.
    steps.forEach((_, n) => after(((n + 1) * STEPS_MS) / steps.length, () => setEntries((e) => [...e.slice(0, -1), { role: "assistant", pending: n + 1 < steps.length, steps, done: n + 1, ...(n + 1 === steps.length ? { cards } : {}) }])));
  };

  const empty = entries.length === 0;
  const composer = (
    <>
      <form onSubmit={(e) => { e.preventDefault(); send(input); }} className="flex items-end gap-2 rounded-2xl border border-line bg-panel p-2 pl-4 focus-within:border-faint">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input); } }}
          rows={1}
          aria-label="Ask or tell the agent what to do"
          className="block max-h-40 min-h-[40px] min-w-0 flex-1 resize-none bg-transparent py-2 text-[15px] outline-none [field-sizing:content] placeholder:text-faint"
        />
        <button type="submit" disabled={!input.trim()} className="grid size-9 place-items-center rounded-xl bg-accent text-white disabled:opacity-30" title="Send">
          <ArrowUp className="size-4" />
        </button>
      </form>
    </>
  );

  return (
    <div className={`min-h-0 flex-1 flex-col ${active ? "flex" : "hidden"}`}>
      <div className="flex-1 overflow-y-auto">
        <div className={`mx-auto w-full max-w-[760px] px-6 py-8 ${empty ? "flex min-h-full flex-col justify-center" : ""}`}>
          {empty && (
            <div>
              <h1 className="mb-6 text-center text-[36px] font-bold leading-tight tracking-tight">What do you want to do on-chain?</h1>
              {composer}
            </div>
          )}
          {entries.map((entry, i) =>
            entry.role === "user" ? (
              <div key={i} className="mb-6 flex justify-end">
                <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-raised px-4 py-2.5 text-[15px] leading-relaxed">{entry.text}</div>
              </div>
            ) : (
              <div key={i} className="mb-8">
                {entry.steps && (
                  <div className="mb-3 space-y-1.5">
                    {entry.steps.slice(0, (entry.done ?? 0) + 1).map((step, n) => (
                      <div key={n} className="step-in flex items-center gap-2 text-[13px] text-dim">
                        {n < (entry.done ?? 0) ? <Check className="size-3.5 shrink-0 text-good" /> : <Loader2 className="size-3.5 shrink-0 animate-spin text-accent" />}
                        <span>{step}</span>
                      </div>
                    ))}
                  </div>
                )}
                {entry.pending && !entry.steps && (
                  <div className="flex gap-1 py-2">
                    {[0, 1, 2].map((d) => <span key={d} className="dot size-1.5 rounded-full bg-dim" style={{ animationDelay: `${d * 0.18}s` }} />)}
                  </div>
                )}
                {entry.text && <p className="text-[15px] leading-relaxed text-dim">{entry.text}</p>}
                {entry.cards?.map((card, n) => <Card key={n} card={card} delay={n * 0.25} />)}
              </div>
            ),
          )}
          <div ref={bottom} className="h-4" />
        </div>
      </div>
      {!empty && <div className="mx-auto w-full max-w-[760px] px-6 pb-5">{composer}</div>}
    </div>
  );
}
