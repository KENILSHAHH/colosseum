"use client";

import { ArrowUp, Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/** The demo chat has no server. It reads the words of the user and shows a card for each action, as if the order was filled. */

interface Logo { label: string; src?: string; tile?: boolean; fill?: boolean }
interface DemoCard { logos: Logo[]; venue: Logo; title: string; note?: string; facts: [string, string][] }
interface Entry { role: "user" | "assistant"; text?: string; cards?: DemoCard[]; pending?: boolean }

const PROMPTS = [
  "Buy 5 TSLA shares on Robinhood",
  "Open a 40x long with 0.01 BTC on Hyperliquid",
  "Lend 1 ETH on Aave",
  "Buy yes on Spain winning the next FIFA on World",
];

const VENUES = {
  robinhood: { label: "Robinhood", src: "/icons/robinhood.svg", tile: true },
  hyperliquid: { label: "Hyperliquid", src: "/icons/hyperliquid.webp" },
  aave: { label: "Aave", src: "/icons/aave.webp" },
  world: { label: "World", src: "/icons/world.svg" },
} satisfies Record<string, Logo>;

const TOKENS: Record<string, { logo: Logo; price: number; apy: number }> = {
  BTC: { logo: { label: "Bitcoin", src: "/icons/btc.png" }, price: 98_400, apy: 0.1 },
  ETH: { logo: { label: "Ethereum", src: "/icons/eth.png" }, price: 3_900, apy: 1.9 },
  SOL: { logo: { label: "Solana", src: "/icons/chain-solana.svg" }, price: 210, apy: 3.2 },
  HYPE: { logo: { label: "Hyperliquid", src: "/icons/hyperliquid.webp" }, price: 42, apy: 0 },
  USDC: { logo: { label: "USDC", src: "/icons/usdc.png" }, price: 1, apy: 4.8 },
  USDT: { logo: { label: "USDT", src: "/icons/usdt.png" }, price: 1, apy: 4.3 },
  DAI: { logo: { label: "DAI", src: "/icons/dai.png" }, price: 1, apy: 4.1 },
};

const STOCKS: Record<string, { name: string; logo: Logo; price: number }> = {
  TSLA: { name: "tesla", logo: { label: "Tesla", src: "/icons/tesla.svg", tile: true }, price: 248.5 },
  AAPL: { name: "apple", logo: { label: "Apple", src: "/icons/apple.svg", tile: true }, price: 231.2 },
  NVDA: { name: "nvidia", logo: { label: "Nvidia", src: "/icons/nvidia.svg", tile: true }, price: 188.4 },
  GOOGL: { name: "google", logo: { label: "Google", src: "/icons/google.svg", tile: true }, price: 176.9 },
  META: { name: "meta", logo: { label: "Meta", src: "/icons/meta.svg", tile: true }, price: 612.3 },
  NFLX: { name: "netflix", logo: { label: "Netflix", src: "/icons/netflix.svg", tile: true }, price: 1_180 },
  COIN: { name: "coinbase", logo: { label: "Coinbase", src: "/icons/coinbase.svg", tile: true }, price: 295.6 },
};

const COUNTRIES: Record<string, { name: string; code: string; price: number }> = {
  spain: { name: "Spain", code: "es", price: 0.17 },
  france: { name: "France", code: "fr", price: 0.15 },
  brazil: { name: "Brazil", code: "br", price: 0.09 },
  argentina: { name: "Argentina", code: "ar", price: 0.12 },
  germany: { name: "Germany", code: "de", price: 0.08 },
  england: { name: "England", code: "gb-eng", price: 0.13 },
  portugal: { name: "Portugal", code: "pt", price: 0.07 },
  usa: { name: "USA", code: "us", price: 0.03 },
  italy: { name: "Italy", code: "it", price: 0.05 },
  netherlands: { name: "Netherlands", code: "nl", price: 0.05 },
};

const money = (v: number, d = 2) => `$${v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const amount = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 6 });
const has = (text: string, re: RegExp) => re.test(text);

function token(text: string): [string, (typeof TOKENS)[string]] | null {
  const hit = Object.entries(TOKENS).find(([symbol]) => has(text, new RegExp(`\\b${symbol}\\b`, "i")));
  return hit ?? null;
}

/** One action in, one card out. It returns null when the words are not an action that the demo knows. */
function toCard(raw: string): DemoCard | null {
  const text = raw.toLowerCase();
  const number = (re: RegExp) => { const m = text.match(re); return m ? Number(m[1]) : null; };

  // Prediction market on World.
  if (has(text, /\b(world|fifa|predict|bet|winning|wins?)\b/) && !has(text, /\b(robinhood|hyperliquid|aave)\b/)) {
    const side = has(text, /\bno\b/) && !has(text, /\byes\b/) ? "NO" : "YES";
    const country = Object.entries(COUNTRIES).find(([key]) => has(text, new RegExp(`\\b${key}\\b`)))?.[1];
    const fifa = has(text, /fifa|world cup/);
    if (!country && !fifa) return null;
    const cost = number(/\$\s*(\d+(?:\.\d+)?)/) ?? 10;
    const price = country?.price ?? 0.5;
    const logos: Logo[] = [];
    if (country) logos.push({ label: country.name, src: `/icons/flag-${country.code}.png`, fill: true });
    if (fifa) logos.push({ label: "FIFA", src: "/icons/fifa.svg", tile: true });
    return {
      logos,
      venue: VENUES.world,
      title: `Bought ${side}${country ? ` · ${country.name}` : ""}`,
      note: fifa ? "FIFA World Cup 2030" : undefined,
      facts: [["Price", `${Math.round(price * 100)}¢`], ["Shares", amount(Math.round((cost / price) * 10) / 10)], ["Cost", money(cost)]],
    };
  }

  // Stock on Robinhood.
  const stock = Object.entries(STOCKS).find(([symbol, s]) => has(text, new RegExp(`\\b(${symbol.toLowerCase()}|${s.name})\\b`)));
  if (stock || has(text, /\b(robinhood|shares?|stocks?)\b/)) {
    const qty = number(/(\d+(?:\.\d+)?)/) ?? 1;
    const [symbol, info] = stock ?? [(text.match(/\d+(?:\.\d+)?\s+([a-z]{1,5})\s+shares?/)?.[1] ?? "AAPL").toUpperCase(), undefined];
    const price = info?.price ?? 100;
    return {
      logos: [info?.logo ?? { label: symbol }],
      venue: VENUES.robinhood,
      title: `Bought ${amount(qty)} ${symbol}`,
      facts: [["Price", money(price)], ["Total", money(qty * price)]],
    };
  }

  // Perpetual on Hyperliquid.
  const leverage = number(/(\d+)\s*x\b/);
  const side = text.match(/\b(long|short)\b/)?.[1];
  if (leverage || side) {
    const [symbol, info] = token(text) ?? ["BTC", TOKENS.BTC!];
    const size = number(new RegExp(`(\\d*\\.?\\d+)\\s*${symbol}\\b`, "i")) ?? 0.01;
    const lev = leverage ?? 10;
    const notional = size * info.price;
    const long = side !== "short";
    return {
      logos: [info.logo],
      venue: VENUES.hyperliquid,
      title: `${long ? "Long" : "Short"} ${lev}x · ${amount(size)} ${symbol}`,
      facts: [["Entry", money(info.price, info.price < 100 ? 2 : 0)], ["Margin", money(notional / lev)], ["Liq.", money(info.price * (long ? 1 - 0.9 / lev : 1 + 0.9 / lev), info.price < 100 ? 2 : 0)]],
    };
  }

  // Lending on Aave.
  if (has(text, /\b(aave|lend|lent|lending|supply|supplied)\b/)) {
    const [symbol, info] = token(text) ?? ["ETH", TOKENS.ETH!];
    const qty = number(/(\d+(?:\.\d+)?)/) ?? 1;
    return {
      logos: [info.logo],
      venue: VENUES.aave,
      title: `Lent ${amount(qty)} ${symbol}`,
      facts: [["APY", `${info.apy.toFixed(2)}%`], ["Value", money(qty * info.price)]],
    };
  }

  // Spot buy on Hyperliquid.
  if (has(text, /\bhyperliquid\b/)) {
    const [symbol, info] = token(text) ?? ["ETH", TOKENS.ETH!];
    const qty = number(/(\d*\.?\d+)\s*[a-z]/) ?? 1;
    return {
      logos: [info.logo],
      venue: VENUES.hyperliquid,
      title: `Bought ${amount(qty)} ${symbol}`,
      facts: [["Price", money(info.price)], ["Total", money(qty * info.price)]],
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
    if (!prompt) return;
    setInput("");
    setEntries((e) => [...e, { role: "user", text: prompt }, { role: "assistant", pending: true }]);
    // A short wait, so that the answer looks like the work of an agent.
    timers.current.push(
      window.setTimeout(() => {
        const cards = toCards(prompt);
        setEntries((e) => [...e.slice(0, -1), cards.length ? { role: "assistant", cards } : { role: "assistant", text: "I did not find an action in your message. Try one of the examples below." }]);
      }, 900),
    );
  };

  const empty = entries.length === 0;
  const chips = (
    <div className="mt-4 flex flex-wrap justify-center gap-2">
      {PROMPTS.map((p) => (
        <button key={p} onClick={() => send(p)} className="rounded-full border border-line px-3 py-1.5 text-[12.5px] text-dim hover:bg-raised hover:text-ink">
          {p}
        </button>
      ))}
    </div>
  );
  const composer = (
    <>
      <form onSubmit={(e) => { e.preventDefault(); send(input); }} className="flex items-end gap-2 rounded-2xl border border-line bg-panel p-2 pl-4 focus-within:border-faint">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input); } }}
          rows={1}
          aria-label="Tell the demo agent what to do"
          placeholder="Buy 5 TSLA shares on Robinhood"
          className="block max-h-40 min-h-[40px] min-w-0 flex-1 resize-none bg-transparent py-2 text-[15px] outline-none [field-sizing:content] placeholder:text-faint"
        />
        <button type="submit" disabled={!input.trim()} className="grid size-9 place-items-center rounded-xl bg-accent text-white disabled:opacity-30" title="Send">
          <ArrowUp className="size-4" />
        </button>
      </form>
      <p className="mt-2 px-1 text-center text-[12px] text-faint">Demo mode. The agent does not place real orders here.</p>
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
              {chips}
            </div>
          )}
          {entries.map((entry, i) =>
            entry.role === "user" ? (
              <div key={i} className="mb-6 flex justify-end">
                <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-raised px-4 py-2.5 text-[15px] leading-relaxed">{entry.text}</div>
              </div>
            ) : (
              <div key={i} className="mb-8">
                {entry.pending && (
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
      {!empty && <div className="mx-auto w-full max-w-[760px] px-6 pb-5">{composer}{entries.at(-1)?.text && chips}</div>}
    </div>
  );
}
