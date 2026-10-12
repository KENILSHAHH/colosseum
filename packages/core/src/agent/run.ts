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
  const rpcs = [c.RPC_ETHEREUM, c.RPC_ARBITRUM, c.RPC_BASE, c.RPC_ROBINHOOD, c.RPC_TEMPO, c.RPC_HYPEREVM, c.RPC_SOLANA].flatMap((url) => {
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
  const wallet = await getOrCreateWallet(args.userId);
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
    mcpServers: { [SERVER_NAME]: server },
    // Project skills only. User-level settings of the host machine do not load.
    settingSources: ["project"],
    // Only the product skills. The skills bundled with the runtime stay off.
    skills: PRODUCT_SKILLS,
    tools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "Skill"],
    allowedTools: [...allToolNames(), "Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "Skill"],
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
    // A long task (build, test on a fork, deploy, schedule) needs many steps. The daily budget of the user is the only cost limit.
    maxTurns: 300,
    maxBudgetUsd: c.USER_DAILY_LLM_BUDGET_USD,
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
    yield userMessage(args.prompt);
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

  try {
    for await (const msg of query({ prompt: input(), options })) {
      if (msg.type === "system" && msg.subtype === "init") {
        sessionId = msg.session_id;
        yield { type: "session", sessionId, skills: msg.skills ?? [] };
      } else if (msg.type === "stream_event") {
        const ev = msg.event;
        if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") yield { type: "text", delta: ev.delta.text };
      } else if (msg.type === "assistant" && msg.parent_tool_use_id === null) {
        for (const block of msg.message.content) {
          if (block.type === "tool_use") yield { type: "tool", id: block.id, name: block.name.replace(`mcp__${SERVER_NAME}__`, ""), input: block.input };
        }
      } else if (msg.type === "user" && msg.parent_tool_use_id === null && Array.isArray(msg.message.content)) {
        for (const block of msg.message.content) {
          if (block.type !== "tool_result") continue;
          const text = typeof block.content === "string" ? block.content : (block.content ?? []).map((b) => (b.type === "text" ? b.text : "")).join("");
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
