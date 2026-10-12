"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ArrowUp, ChevronRight, Mic, Square, Wrench } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { IntentCard } from "@/components/IntentCard";
import { PermissionCard } from "@/components/PermissionCard";
import { WalletRequestCard } from "@/components/WalletRequestCard";
import { PositionsView } from "@/components/Positions";
import { Sidebar } from "@/components/Sidebar";
import { chat, post, usd, type Intent, type Permission, type WalletRequest } from "@/lib/api";
import { useSession } from "@/lib/session";

type Part =
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; input: unknown; result?: string; isError?: boolean }
  | { kind: "intent"; intent: Intent }
  | { kind: "permission"; permission: Permission }
  | { kind: "wallet_request"; request: WalletRequest };

interface Message {
  role: "user" | "assistant";
  parts: Part[];
  cost?: { chargedUsd: number; costUsd: number };
  error?: string;
}

const SUGGESTIONS = [
  "What's the best USDC lending rate across my chains right now?",
  "Take a 10x long on BTC with $2 margin on Hyperliquid.",
  "Supply 20 USDC on Base Aave, borrow ETH at 40% LTV, and don't let it get liquidated.",
  "What do I hold right now, and what is at risk?",
];

const TOOL_LABELS: Record<string, string> = {
  rates_compare: "Compare lending rates",
  hl_markets: "Search Hyperliquid markets",
  hl_account: "Read Hyperliquid account",
  hl_outcomes: "List outcome markets",
  sol_quote: "Quote Solana swap",
  bridge_quote: "Quote bridge route",
  aave_account: "Read Aave account",
  evm_simulate: "Simulate transactions",
    hl_open_position: "Open position",
  hl_close_position: "Close position",
  aave_supply_borrow: "Supply and borrow",
  bridge: "Bridge funds",
  bridge_status: "Check bridge status",
  wallet_overview: "Read agent wallet",
  evm_send_transactions: "Send transactions",
  aave_v4_markets: "Read Aave v4 markets",
  aave_v4_account: "Read Aave v4 position",
  aave_v4_action: "Aave v4 action",
  hl_deposit: "Deposit to Hyperliquid",
  job_schedule: "Schedule a job",
  job_list: "List jobs",
  job_cancel: "Cancel a job",
  linked_wallet_permission_context: "Read a permission",
  linked_wallet_ask_to_sign: "Ask you to sign",
  flash_run: "Flash run",
  linked_wallet_overview: "Read your wallet",
  linked_wallet_request_permission: "Ask for a permission",
  linked_wallet_send_transactions: "Send from your wallet",
  guard_register_aave: "Register guard",
  Skill: "Read protocol notes",
  Bash: "Run command",
  Read: "Read file",
  Write: "Write file",
  Edit: "Edit file",
  Grep: "Search files",
  Glob: "Find files",
  WebFetch: "Read web page",
  WebSearch: "Search the web",
};

function toolDetail(name: string, input: any): string {
  if (!input || typeof input !== "object") return "";
  if (name === "Bash") return String(input.command ?? "").slice(0, 90);
  if (name === "Skill") return String(input.skill ?? "");
  if (name === "WebFetch") return String(input.url ?? "").replace(/^https?:\/\//, "").slice(0, 70);
  if (name === "WebSearch") return String(input.query ?? "");
  if (name === "Read" || name === "Write" || name === "Edit") return String(input.file_path ?? "").split("/").slice(-2).join("/");
  return Object.values(input).filter((v) => typeof v === "string" || typeof v === "number").slice(0, 4).join(" · ");
}

export default function Page() {
  const session = useSession();
  const qc = useQueryClient();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"chat" | "positions">("chat");
  const sessionId = useRef<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const [hintIndex, setHintIndex] = useState(0);
  const [voiceOk, setVoiceOk] = useState(false);
  const [listening, setListening] = useState(false);
  const [voiceError, setVoiceError] = useState("");
  const recognition = useRef<any>(null);
  const voiceLang = useRef<string | null>(null);

  useEffect(() => {
    const t = setInterval(() => setHintIndex((i) => (i + 1) % SUGGESTIONS.length), 2000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const w = window as any;
    setVoiceOk(Boolean(w.SpeechRecognition || w.webkitSpeechRecognition));
    return () => recognition.current?.abort();
  }, []);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  const patchLast = useCallback((fn: (m: Message) => Message) => {
    setMessages((all) => (all.length ? [...all.slice(0, -1), fn(all[all.length - 1]!)] : all));
  }, []);

  const send = useCallback(
    async (text: string) => {
      const prompt = text.trim();
      if (!prompt || busy || !session.signedIn) return;
      recognition.current?.abort();
      setListening(false);
      setInput("");
      setBusy(true);
      setMessages((m) => [...m, { role: "user", parts: [{ kind: "text", text: prompt }] }, { role: "assistant", parts: [] }]);
      abort.current = new AbortController();
      try {
        for await (const ev of chat(prompt, sessionId.current, abort.current.signal)) {
          if (ev.type === "session") sessionId.current = ev.sessionId;
          else if (ev.type === "text")
            patchLast((m) => {
              const last = m.parts[m.parts.length - 1];
              return last?.kind === "text"
                ? { ...m, parts: [...m.parts.slice(0, -1), { kind: "text", text: last.text + ev.delta }] }
                : { ...m, parts: [...m.parts, { kind: "text", text: ev.delta }] };
            });
          else if (ev.type === "tool") patchLast((m) => ({ ...m, parts: [...m.parts, { kind: "tool", id: ev.id, name: ev.name, input: ev.input }] }));
          else if (ev.type === "tool_result")
            patchLast((m) => ({ ...m, parts: m.parts.map((p) => (p.kind === "tool" && p.id === ev.id ? { ...p, result: ev.preview, isError: ev.isError } : p)) }));
          else if (ev.type === "permission") patchLast((m) => ({ ...m, parts: [...m.parts, { kind: "permission", permission: ev.permission }] }));
          else if (ev.type === "intent")
            patchLast((m) =>
              m.parts.some((p) => p.kind === "intent" && p.intent.id === ev.intent.id)
                ? { ...m, parts: m.parts.map((p) => (p.kind === "intent" && p.intent.id === ev.intent.id ? { kind: "intent", intent: ev.intent } : p)) }
                : { ...m, parts: [...m.parts, { kind: "intent", intent: ev.intent }] },
            );
          else if (ev.type === "done") {
            patchLast((m) => ({ ...m, cost: { chargedUsd: ev.chargedUsd, costUsd: ev.costUsd } }));
            qc.invalidateQueries({ queryKey: ["billing"] });
            qc.invalidateQueries({ queryKey: ["me"] });
          else if (ev.type === "wallet_request") patchLast((m) => ({ ...m, parts: [...m.parts, { kind: "wallet_request", request: ev.request }] }));
          } else if (ev.type === "error") patchLast((m) => ({ ...m, error: ev.message }));
        }
      } catch (e) {
        if ((e as Error).name !== "AbortError") patchLast((m) => ({ ...m, error: e instanceof Error ? e.message : "The request failed" }));
      } finally {
        setBusy(false);
      }
    },
    [busy, session.signedIn, patchLast, qc],
  );

  const toggleVoice = () => {
    if (listening) {
      recognition.current?.stop();
      return;
    }
    const w = window as any;
    const Recognition = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Recognition) return;
    const base = input.trim();
    const rec = new Recognition();
    rec.lang = voiceLang.current ?? (navigator.language || "en-US");
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e: any) => {
      let spoken = "";
      for (let i = 0; i < e.results.length; i++) spoken += e.results[i][0].transcript;
      setInput(base ? `${base} ${spoken.trim()}` : spoken.trim());
    };
    rec.onerror = (e: any) => {
      // "aborted" comes from our own stop (a sent message, a second click). "no-speech" is silence. Neither is a failure.
      if (e.error === "aborted" || e.error === "no-speech") return;
      const messages: Record<string, string> = {
        "not-allowed": "Microphone access is blocked. Allow it in the browser settings.",
        "service-not-allowed": "Microphone access is blocked. Allow it in the browser settings.",
        "audio-capture": "No microphone was found. Connect one and try again.",
        // Chrome sends the audio to its speech service. Brave and some other browsers have no such service.
        network: "The speech service of this browser did not answer. Use Chrome, Edge or Safari, and check the connection.",
        "language-not-supported": "The speech service does not support your browser language. Voice input now uses English.",
      };
      // The next attempt uses English when the browser language has no speech support.
      if (e.error === "language-not-supported") voiceLang.current = "en-US";
      setVoiceError(messages[e.error] ?? `Voice input failed (${e.error || "unknown error"}). Try again.`);
    };
    rec.onend = () => setListening(false);
    recognition.current = rec;
    setVoiceError("");
    try {
      rec.start();
      setListening(true);
    } catch {
      // start() throws when an earlier session is still closing. One more click starts a new one.
      setVoiceError("Voice input is not ready yet. Click the microphone again.");
    }
  };

  const newChat = () => {
    abort.current?.abort();
    sessionId.current = null;
    setMessages([]);
  };

  const empty = messages.length === 0;

  const hint = !session.signedIn ? "Sign in to chat" : listening ? "Listening…" : SUGGESTIONS[hintIndex];
  const composer = (
    <>
    <form
      onSubmit={(e) => {
        e.preventDefault();
        send(input);
      }}
      className="flex items-end gap-2 rounded-2xl border border-line bg-panel p-2 pl-4 focus-within:border-faint"
    >
      <div className="relative min-w-0 flex-1">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(input);
            }
          }}
          rows={1}
          aria-label="Ask or tell the agent what to do"
          disabled={!session.signedIn}
          className="block max-h-40 min-h-[40px] w-full resize-none bg-transparent py-2 text-[15px] outline-none [field-sizing:content]"
        />
        {!input && (
          <span className="pointer-events-none absolute inset-0 flex items-center truncate text-[15px] text-faint">{hint}</span>
        )}
      </div>
      {voiceOk && (
        <button
          type="button"
          onClick={toggleVoice}
          disabled={!session.signedIn || busy}
          aria-pressed={listening}
          className={`grid size-9 place-items-center rounded-xl disabled:opacity-30 ${listening ? "dot bg-accent text-black" : "bg-raised text-dim hover:text-ink"}`}
          title={listening ? "Stop listening" : "Speak your request"}
        >
          <Mic className="size-4" />
        </button>
      )}
      {busy ? (
        <button type="button" onClick={() => abort.current?.abort()} className="grid size-9 place-items-center rounded-xl bg-raised text-ink" title="Stop">
          <Square className="size-3.5 fill-current" />
        </button>
      ) : (
        <button type="submit" disabled={!input.trim() || !session.signedIn} className="grid size-9 place-items-center rounded-xl bg-accent text-black disabled:opacity-30" title="Send">
          <ArrowUp className="size-4" />
        </button>
      )}
    </form>
    {voiceError && <p className="mt-2 px-1 text-[12.5px] text-bad">{voiceError}</p>}
    </>
  );

  return (
    <div className="flex h-dvh">
      <Sidebar session={session} onNewChat={newChat} />

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-1 border-b border-line px-6 py-2">
          {(["chat", "positions"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={`rounded-lg px-3 py-1.5 text-sm capitalize ${tab === t ? "bg-raised text-ink" : "text-dim hover:text-ink"}`}>
              {t}
            </button>
          ))}
        </div>
        {tab === "positions" && <div className="flex-1 overflow-y-auto">{session.signedIn ? <PositionsView /> : <p className="p-8 text-sm text-faint">Sign in to see positions.</p>}</div>}
        <div className={`flex-1 overflow-y-auto ${tab === "chat" ? "" : "hidden"}`}>
          <div className={`mx-auto w-full max-w-[760px] px-6 py-8 ${empty ? "flex min-h-full flex-col justify-center" : ""}`}>
            {empty && (
              <div>
                <h1 className="mb-6 text-center text-[36px] font-bold leading-tight tracking-tight">What do you want to do on-chain?</h1>
                {composer}
                {!session.signedIn && <p className="mt-5 text-center text-[13px] text-faint">Connect a wallet and sign in to start.</p>}
              </div>
            )}

            {messages.map((m, i) => (
              <MessageView key={i} message={m} streaming={busy && i === messages.length - 1} />
            ))}
            <div ref={bottom} className="h-4" />
          </div>
        </div>

        {!empty && <div className={`mx-auto w-full max-w-[760px] px-6 pb-5 ${tab === "chat" ? "" : "hidden"}`}>{composer}</div>}
      </main>
    </div>
  );
}

function MessageView({ message, streaming }: { message: Message; streaming: boolean }) {
  if (message.role === "user") {
    const text = message.parts[0]?.kind === "text" ? message.parts[0].text : "";
    return (
      <div className="mb-6 flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-raised px-4 py-2.5 text-[15px] leading-relaxed">{text}</div>
      </div>
    );
  }
  const waiting = streaming && message.parts.length === 0;
  // Steps that follow each other become one line. Text and cards stay as they are.
  type ToolPart = Extract<Part, { kind: "tool" }>;
  const blocks: (Exclude<Part, ToolPart> | { kind: "steps"; steps: ToolPart[] })[] = [];
  for (const p of message.parts) {
    const last = blocks[blocks.length - 1];
    if (p.kind === "tool" && last?.kind === "steps") last.steps.push(p);
    else blocks.push(p.kind === "tool" ? { kind: "steps", steps: [p] } : p);
  }
  return (
    <div className="mb-8">
      {blocks.map((p, i) => {
        if (p.kind === "steps") return <StepsLine key={p.steps[0]!.id} steps={p.steps} live={streaming && i === blocks.length - 1} />;
        if (p.kind === "text")
          return (
            <div key={i} className="prose-agent">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ table: (props) => <div className="table-wrap"><table {...props} /></div>, a: (props) => <a {...props} target="_blank" rel="noreferrer" /> }}>
                {p.text}
              </ReactMarkdown>
            </div>
          );
        if (p.kind === "permission") return <PermissionCard key={p.permission.id} permission={p.permission} />;
        return <IntentCard key={p.intent.id} intent={p.intent} />;
      })}
      {waiting && (
        <div className="flex gap-1 py-2">
          {[0, 1, 2].map((d) => (
            <span key={d} className="dot size-1.5 rounded-full bg-dim" style={{ animationDelay: `${d * 0.18}s` }} />
          ))}
        </div>
      )}
      {message.error && <div className="mt-3 rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-[13.5px] text-bad">{message.error}</div>}
      {message.cost && (
        if (p.kind === "wallet_request") return <WalletRequestCard key={p.request.id} request={p.request} />;
        <div className="mt-3 text-[11.5px] text-faint">
          Charged {usd(message.cost.chargedUsd)} · model cost {usd(message.cost.costUsd)}
        </div>
      )}
    </div>
  );
}

/**
 * The steps of the agent as one line. While the agent works, the line shows the step that runs now.
 * After that it rotates through the steps. A click opens the full list.
 */
function StepsLine({ steps, live }: { steps: Extract<Part, { kind: "tool" }>[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const [turn, setTurn] = useState(0);
  useEffect(() => {
    if (live || open || steps.length < 2) return;
    const t = setInterval(() => setTurn((n) => n + 1), 2200);
    return () => clearInterval(t);
  }, [live, open, steps.length]);
  const shown = live ? steps[steps.length - 1]! : steps[turn % steps.length]!;
  const detail = toolDetail(shown.name, shown.input);
  const pending = steps.some((s) => s.result === undefined);
  const failed = steps.filter((s) => s.isError).length;
  return (
    <div className="my-2">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} title={open ? "Hide the steps" : "Show the steps"} className="flex w-full max-w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left text-[13px] text-dim hover:bg-panel">
        <Wrench className={`size-3.5 shrink-0 ${pending ? "dot text-accent" : "text-faint"}`} />
        {open ? (
          <span className="min-w-0 flex-1">Steps</span>
        ) : (
          <span key={shown.id} className="step-in flex min-w-0 flex-1 items-center gap-2">
            <span className="shrink-0">{TOOL_LABELS[shown.name] ?? shown.name}</span>
            {detail && <span className="truncate font-mono text-[12px] text-faint">{detail}</span>}
          </span>
        )}
        <span className="shrink-0 text-[12px] text-faint">
          {steps.length} {steps.length === 1 ? "step" : "steps"}
          {failed > 0 && <span className="text-bad"> · {failed} failed</span>}
        </span>
        <ChevronRight className={`size-3 shrink-0 text-faint transition ${open ? "rotate-90" : ""}`} />
      </button>
      {open && <div className="ml-2 border-l border-line pl-2">{steps.map((s) => <ToolRow key={s.id} part={s} />)}</div>}
    </div>
  );
}

function ToolRow({ part }: { part: Extract<Part, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const detail = toolDetail(part.name, part.input);
  const pending = part.result === undefined;
  return (
    <div className="my-1.5">
      <button onClick={() => setOpen((o) => !o)} className="group flex max-w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left text-[13px] text-dim hover:bg-panel">
        <Wrench className={`size-3.5 shrink-0 ${pending ? "dot text-accent" : part.isError ? "text-bad" : "text-faint"}`} />
        <span className="shrink-0">{TOOL_LABELS[part.name] ?? part.name}</span>
        {detail && <span className="truncate font-mono text-[12px] text-faint">{detail}</span>}
        <ChevronRight className={`size-3 shrink-0 text-faint transition ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <pre className="mt-1 max-h-64 overflow-auto rounded-lg border border-line bg-panel p-3 font-mono text-[11.5px] leading-relaxed text-dim">
          {JSON.stringify(part.input, null, 2)}
          {part.result !== undefined && `\n\n→ ${part.result}`}
        </pre>
      )}
    </div>
  );
}
