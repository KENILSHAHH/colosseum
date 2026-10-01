// The chat agent loop. It runs the Claude Agent SDK with the typed DeFi tools, the project skills and a terminal.
// SDK reference: https://code.claude.com/docs/en/agent-sdk/typescript
import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { recordUsage } from "../billing/pricing";
import { config } from "../config";
import type { Intent } from "../intents";
import { llmSessionToken } from "../llmProxy";
import { allToolNames, buildTools, SERVER_NAME } from "../tools/index";
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
  | { type: "done"; costUsd: number; chargedUsd: number; turns: number; stopReason: string }
  | { type: "error"; message: string };

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

export async function* runChatAgent(args: RunArgs): AsyncGenerator<AgentEvent> {
  const c = config();
  const { cwd, configDir } = workspaceFor(args.userId);
  const pending: Intent[] = [];
  const wallet = await getOrCreateWallet(args.userId);
  const permissions: Permission[] = [];
  const server = buildTools({ userId: args.userId, wallet, onIntent: (i) => pending.push(i), onPermission: (p) => permissions.push(p) });

  const abort = new AbortController();
  args.signal?.addEventListener("abort", () => abort.abort(), { once: true });

  const options: Options = {
    model: c.CLAUDE_MODEL,
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
    // Terminal commands run in the OS sandbox: writes stay inside the workspace.
    sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false },
    includePartialMessages: true,
    maxTurns: 40,
    maxBudgetUsd: Math.max(0.5, c.USER_DAILY_LLM_BUDGET_USD / 2),
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

  let sessionId: string | null = null;
  const flushIntents = function* (): Generator<AgentEvent> {
    while (pending.length) yield { type: "intent", intent: pending.shift()! };
    while (permissions.length) yield { type: "permission", permission: permissions.shift()! };
  };

  try {
    for await (const msg of query({ prompt: args.prompt, options })) {
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
        const billed = await recordUsage({ userId: args.userId, sessionId, modelUsage: msg.modelUsage });
        yield { type: "done", costUsd: billed.costUsd, chargedUsd: billed.chargedUsd, turns: msg.num_turns, stopReason: msg.subtype };
      }
    }
  } catch (err) {
    yield* flushIntents();
    yield { type: "error", message: err instanceof Error ? err.message : String(err) };
  }
}
