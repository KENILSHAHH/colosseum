// The chat agent loop. It runs the Claude Agent SDK with the typed DeFi tools, the project skills and a terminal.
// SDK reference: https://code.claude.com/docs/en/agent-sdk/typescript
import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query, type Options, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { recordUsage } from "../billing/pricing";
import { config } from "../config";
import type { Intent } from "../intents";
import { llmSessionToken } from "../llmProxy";
import { allToolNames, buildTools, SERVER_NAME, type WalletRequest } from "../tools/index";
import { getOrCreateWallet } from "../wallet";
import type { Permission } from "../delegation";
import { memoryBlock, reflectOnChat, type ChatRecord } from "../memory";
import { CHAT_SYSTEM_PROMPT } from "./prompts";

export type AgentEvent =
  | { type: "session"; sessionId: string; skills: string[] }
  | { type: "text"; delta: string }
  | { type: "tool"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; isError: boolean; preview: string }
  | { type: "intent"; intent: Intent }
  | { type: "permission"; permission: Permission }
  | { type: "wallet_request"; request: WalletRequest }
  | { type: "done"; costUsd: number; chargedUsd: number; turns: number; stopReason: string }
  | { type: "error"; message: string };

/**
 * Hosts the agent terminal can reach from inside the sandbox: the APIs of the supported apps.
 * Every other host stays blocked, so a script cannot send data to an address of its choice.
 */
const TERMINAL_API_HOSTS = [
  // Lending
  "api.aave.com", "api.morpho.org", "api.kamino.finance", "yields.llama.fi", "api.llama.fi", "coins.llama.fi",
  // Hyperliquid
  "api.hyperliquid.xyz",
  // Bridges and swaps
  "api.relay.link", "li.quest", "app.across.to", "lite-api.jup.ag", "quote-api.dflow.net",
  // Tempo and MPP
  "mpp.dev", "tempo.xyz",
  // Prediction markets
  "gamma-api.polymarket.com", "clob.polymarket.com", "data-api.polymarket.com", "quote-api.dflow.net", "prediction-markets-api.dflow.net",
  // Swap and price APIs
  "api.1inch.dev", "api.0x.org", "api.paraswap.io", "apiv5.paraswap.io", "api.odos.xyz", "api.cow.fi", "api.uniswap.org", "api.coingecko.com", "hermes.pyth.network",
  // Contract sources and verification
  "api.etherscan.io", "api.basescan.org", "api.arbiscan.io", "sourcify.dev", "repo.sourcify.dev",
  // What the agent needs to build and test code: packages, compilers, source code
  "github.com", "api.github.com", "raw.githubusercontent.com", "codeload.github.com", "objects.githubusercontent.com",
  "registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "crates.io", "static.crates.io", "binaries.soliditylang.org", "foundry.paradigm.xyz",
];

/** The API hosts plus the RPC host of each chain, so a script and a local fork (anvil) can read the chains. */
function terminalAllowedDomains(): string[] {
  const c = config();
  const rpcs = [c.RPC_ETHEREUM, c.RPC_ARBITRUM, c.RPC_BASE, c.RPC_ROBINHOOD, c.RPC_TEMPO, c.RPC_HYPEREVM, c.RPC_POLYGON, c.RPC_SOLANA].flatMap((url) => {
    try {
      return [new URL(url).hostname];
    } catch {
      return [];
    }
  });
  return [...new Set([...TERMINAL_API_HOSTS, ...rpcs])];
}

/** Tool folders inside a home directory that the terminal must still read: Foundry and Node. */
const TOOLCHAIN_DIRS = [path.join(process.env.HOME ?? "/home/defi", ".foundry"), path.join(process.env.HOME ?? "/home/defi", ".nvm"), path.join(process.env.HOME ?? "/home/defi", ".svm")];

/**
 * Official documentation MCP servers of the supported apps. They only search and read docs.
 * Each also has a feedback tool that sends text out; those are blocked. Checked on 2026-10-12.
 * Aave, Morpho, Kamino and ethereum.org publish no MCP server; the agent reads them with WebFetch and the terminal.
 */
const DOCS_MCP: Record<string, { url: string; tools: string[]; blocked: string[] }> = {
  hyperliquid_docs: { url: "https://hyperliquid.gitbook.io/hyperliquid-docs/~gitbook/mcp", tools: ["searchDocumentation", "getPage"], blocked: ["sendFeedback"] },
  polymarket_docs: { url: "https://docs.polymarket.com/mcp", tools: ["search_polymarket_documentation", "query_docs_filesystem_polymarket_documentation"], blocked: ["submit_feedback"] },
  jupiter_docs: { url: "https://docs.jup.ag/mcp", tools: ["search_jupiter_documentation", "query_docs_filesystem_jupiter_documentation"], blocked: ["submit_feedback"] },
  relay_docs: { url: "https://docs.relay.link/mcp", tools: ["search_relay", "query_docs_filesystem_relay"], blocked: ["submit_feedback"] },
  lifi_docs: { url: "https://docs.li.fi/mcp", tools: ["search_li_fi", "query_docs_filesystem_li_fi"], blocked: ["submit_feedback"] },
  base_docs: { url: "https://docs.base.org/mcp", tools: ["search_base_documentation", "query_docs_filesystem_base_documentation"], blocked: ["submit_feedback"] },
  solana_docs: { url: "https://mcp.solana.com/mcp", tools: ["Solana_Expert__Ask_For_Help", "Solana_Documentation_Search", "list_sections", "get_documentation", "program_autofixer"], blocked: [] },
};
const docsServers = Object.fromEntries(Object.entries(DOCS_MCP).map(([name, d]) => [name, { type: "http" as const, url: d.url }]));
const docsTools = Object.entries(DOCS_MCP).flatMap(([name, d]) => d.tools.map((t) => `mcp__${name}__${t}`));
const docsBlocked = Object.entries(DOCS_MCP).flatMap(([name, d]) => d.blocked.map((t) => `mcp__${name}__${t}`));

const PRODUCT_SKILLS = ["hyperliquid", "tempo-mpp", "solana-defi", "evm-lending", "bridging", "robinhood-chain"];

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../../../", import.meta.url)));

/** One directory per user. The skills are copied in so the agent loads them as project skills. */
function workspaceFor(userId: string): { cwd: string; configDir: string } {
  const base = path.resolve(config().WORKSPACES_DIR, userId.toLowerCase().replace(/[^a-z0-9]/g, ""));
  const cwd = path.join(base, "work");
  const configDir = path.join(base, "config");
  mkdirSync(configDir, { recursive: true });
  const skills = path.join(cwd, ".claude", "skills");
  if (!existsSync(skills)) {
    mkdirSync(path.dirname(skills), { recursive: true });
    cpSync(path.join(REPO_ROOT, ".claude", "skills"), skills, { recursive: true });
  }
  return { cwd, configDir };
}

export interface RunArgs {
  userId: string;
  prompt: string;
  /** Session id from a previous turn of the same chat. */
  resume?: string;
  signal?: AbortSignal;
  /** Test mode: every action waits for a confirmation that never comes, so nothing executes, and no lesson is saved. */
  dryRun?: boolean;
}

/** The open input of one running agent. A message sent during the run goes into it and the agent reads it before its next step. */
interface RunInbox {
  queue: string[];
  closed: boolean;
  wake: (() => void) | null;
}

const inboxes = new Map<string, RunInbox>();

/** Give a message to the run of the user that is active now. Returns false when no run accepts it. */
export function sendToRun(userId: string, text: string): boolean {
  const inbox = inboxes.get(userId);
  if (!inbox || inbox.closed) return false;
  inbox.queue.push(text);
  inbox.wake?.();
  return true;
}

const userMessage = (text: string, priority?: SDKUserMessage["priority"]): SDKUserMessage => ({
  type: "user",
  message: { role: "user", content: text },
  parent_tool_use_id: null,
  ...(priority ? { priority } : {}),
});

const FILE_TOOLS = "Read|Write|Edit|Glob|Grep|NotebookEdit";

export async function* runChatAgent(args: RunArgs): AsyncGenerator<AgentEvent> {
  const c = config();
  const { cwd, configDir } = workspaceFor(args.userId);
  const base = path.dirname(cwd);
  // The file tools do not run in the terminal sandbox. This hook keeps them inside the workspace of the user,
  // so the agent cannot read the secrets of the server or the files of another user.
  const insideWorkspace = (p: string) => {
    const full = path.resolve(cwd, p);
    return full === base || full.startsWith(base + path.sep);
  };
  const fileGuard = async (input: { tool_input?: unknown }) => {
    const t = (input.tool_input ?? {}) as Record<string, unknown>;
    const target = [t.file_path, t.path, t.notebook_path].find((v): v is string => typeof v === "string");
    if (target && !insideWorkspace(target))
      return { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: "Files outside your workspace are not available. Work inside the current directory." } };
    return {};
  };
  const pending: Intent[] = [];
  const wallet = { ...(await getOrCreateWallet(args.userId)), ...(args.dryRun ? { autoExecute: false } : {}) };
  const permissions: Permission[] = [];
  const walletRequests: WalletRequest[] = [];
  const server = buildTools({ userId: args.userId, wallet, onIntent: (i) => pending.push(i), onPermission: (p) => permissions.push(p), onWalletRequest: (r) => walletRequests.push(r) });

  const abort = new AbortController();
  args.signal?.addEventListener("abort", () => abort.abort(), { once: true });

  const options: Options = {
    model: c.CLAUDE_MODEL,
    effort: c.CLAUDE_EFFORT,
    systemPrompt: CHAT_SYSTEM_PROMPT,
    cwd,
    abortController: abort,
    resume: args.resume,
    mcpServers: { [SERVER_NAME]: server, ...docsServers },
    // Project skills only. User-level settings of the host machine do not load.
    settingSources: ["project"],
    // Only the product skills. The skills bundled with the runtime stay off.
    skills: PRODUCT_SKILLS,
    tools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "Skill"],
    allowedTools: [...allToolNames(), "Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "Skill", ...docsTools],
    disallowedTools: docsBlocked,
    // Tools that are not pre-approved are denied. No prompt can appear on a server.
    permissionMode: "dontAsk",
    // Terminal commands run in the OS sandbox: writes stay inside the workspace, and the network is limited to the app APIs and the chain RPCs.
    // The terminal cannot read the code and the secrets of the server, the home directories, or the workspace of another user.
    sandbox: {
      enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false,
      network: { allowedDomains: terminalAllowedDomains(), allowLocalBinding: true },
      filesystem: { denyRead: [REPO_ROOT, path.resolve(c.WORKSPACES_DIR), "/home", "/root", "/Users", "/etc/caddy"], allowRead: [base, ...TOOLCHAIN_DIRS], allowWrite: [base] },
    },
    includePartialMessages: true,
    // A long task (build, test on a fork, deploy, schedule) needs many steps. There is no cost limit.
    maxTurns: 300,
    hooks: { PreToolUse: [{ matcher: FILE_TOOLS, hooks: [fileGuard as never] }] },
    // The subprocess environment holds no secret. It reaches Claude through the local proxy with a session token.
    env: {
      PATH: process.env.PATH,
      HOME: configDir,
      LANG: process.env.LANG ?? "en_US.UTF-8",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${c.LLM_PROXY_PORT}`,
      ANTHROPIC_API_KEY: llmSessionToken(args.userId),
      CLAUDE_CONFIG_DIR: configDir,
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    },
  };

  // Streaming input: the first prompt starts the run. The input stays open, so a later message reaches the same run without an interrupt.
  // It closes when a turn ends and no message waits.
  const inbox: RunInbox = { queue: [], closed: false, wake: null };
  inboxes.set(args.userId, inbox);
  async function* input(): AsyncGenerator<SDKUserMessage> {
    // A new chat starts with the memory. A resumed chat has it already.
    yield userMessage(args.resume ? args.prompt : `${await memoryBlock(args.userId)}${args.prompt}`);
    for (;;) {
      while (inbox.queue.length) yield userMessage(inbox.queue.shift()!, "next");
      if (inbox.closed) return;
      await new Promise<void>((resolve) => (inbox.wake = resolve));
      inbox.wake = null;
    }
  }

  let sessionId: string | null = null;
  const flushIntents = function* (): Generator<AgentEvent> {
    while (pending.length) yield { type: "intent", intent: pending.shift()! };
    while (permissions.length) yield { type: "permission", permission: permissions.shift()! };
    while (walletRequests.length) yield { type: "wallet_request", request: walletRequests.shift()! };
  };

  // A short record of the chat, for the review that saves lessons afterwards.
  const record: ChatRecord = { prompt: args.prompt, reply: "", steps: [], tools: allToolNames().map((t) => t.replace(`mcp__${SERVER_NAME}__`, "")) };
  const pendingSteps = new Map<string, { tool: string; input: string }>();
  try {
    for await (const msg of query({ prompt: input(), options })) {
      if (msg.type === "system" && msg.subtype === "init") {
        sessionId = msg.session_id;
        yield { type: "session", sessionId, skills: msg.skills ?? [] };
      } else if (msg.type === "stream_event") {
        const ev = msg.event;
        if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
          record.reply += ev.delta.text;
          yield { type: "text", delta: ev.delta.text };
        }
      } else if (msg.type === "assistant" && msg.parent_tool_use_id === null) {
        for (const block of msg.message.content) {
          if (block.type !== "tool_use") continue;
          pendingSteps.set(block.id, { tool: block.name.replace(`mcp__${SERVER_NAME}__`, ""), input: JSON.stringify(block.input) });
          yield { type: "tool", id: block.id, name: block.name.replace(`mcp__${SERVER_NAME}__`, ""), input: block.input };
        }
      } else if (msg.type === "user" && msg.parent_tool_use_id === null && Array.isArray(msg.message.content)) {
        for (const block of msg.message.content) {
          if (block.type !== "tool_result") continue;
          const text = typeof block.content === "string" ? block.content : (block.content ?? []).map((b) => (b.type === "text" ? b.text : "")).join("");
          const step = pendingSteps.get(block.tool_use_id);
          if (step) record.steps.push({ ...step, ok: block.is_error !== true && !text.startsWith("Error:"), result: text.slice(0, 1000) });
          yield { type: "tool_result", id: block.tool_use_id, isError: block.is_error === true, preview: text.slice(0, 2000) };
        }
        yield* flushIntents();
      } else if (msg.type === "result") {
        yield* flushIntents();
        // A message can wait. The agent answers it in a new turn of the same run, and the cost total only grows.
        if (inbox.queue.length) continue;
        inbox.closed = true;
        inbox.wake?.();
        const billed = await recordUsage({ userId: args.userId, sessionId, modelUsage: msg.modelUsage });
        // Learn from this chat in the background. The user does not wait for it.
        if (!args.dryRun) void reflectOnChat(args.userId, { ...record, steps: [...record.steps] }).then(
          (n) => n > 0 && console.log(`memory: saved ${n} lesson(s) from a chat of ${args.userId}`),
          (err) => console.error("memory: the review failed:", err instanceof Error ? err.message.split("\n")[0] : err),
        );
        yield { type: "done", costUsd: billed.costUsd, chargedUsd: billed.chargedUsd, turns: msg.num_turns, stopReason: msg.subtype };
      }
    }
  } catch (err) {
    yield* flushIntents();
    yield { type: "error", message: err instanceof Error ? err.message : String(err) };
  } finally {
    inbox.closed = true;
    inbox.wake?.();
    if (inboxes.get(args.userId) === inbox) inboxes.delete(args.userId);
  }
}
