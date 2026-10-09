---
name: agent-runtime
description: How this product runs its agent. Claude Agent SDK facts (subprocess model, in-process MCP tools, skills, hooks, cost fields), the confirm-before-execute rule, key isolation, and MPP metering. Use when changing the agent loop, tools, permissions, or billing.
user-invocable: false
---

# Agent runtime

Verified against code.claude.com/docs/en/agent-sdk on 2026-10-11 (SDK 0.3.296).

## Claude Agent SDK facts

- Package `@anthropic-ai/claude-agent-sdk`. `query({ prompt, options })` returns an async generator of messages.
- `query()` starts one `claude` CLI subprocess per session. Budget about 1 GiB RAM and 1 CPU per live session.
- Custom tools: `tool(name, description, zodShape, handler)` plus `createSdkMcpServer({ name, tools })`. Pass it in `options.mcpServers`. Tool names become `mcp__<server>__<tool>`. Handlers run in our Node process, not in the subprocess.
- `allowedTools` pre-approves tools. It does not restrict the tool set. `disallowedTools: ["Bash"]` removes a tool. `tools` sets the built-in tool set.
- Skills load from `<cwd>/.claude/skills/*/SKILL.md` when `settingSources` includes `"project"`. `skills: "all"` enables them.
- `hooks.PreToolUse` can deny a call: return `{ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason } }`.
- The final message has `type: "result"`, `total_cost_usd`, `modelUsage` (per model, includes subagents) and `usage`. Use `modelUsage` for billing.
- `includePartialMessages: true` yields `stream_event` messages for token streaming.
- `maxTurns` and `maxBudgetUsd` bound a run. `env` replaces the subprocess environment in TypeScript, so spread what is needed.
- Multi-tenant: one `cwd` per user, `CLAUDE_CONFIG_DIR` per user, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`.

## Rules of this product

1. Each user has one agent wallet (one EVM key, same address on every EVM chain and on Hyperliquid). The user funds it. The server holds the key, encrypted. This is a custodial design.
2. The key never enters the agent subprocess or the workspace. Tool handlers in the API process sign.
3. The Claude API key is not given to the subprocess. The subprocess gets `ANTHROPIC_BASE_URL` of a local proxy that adds the key and checks the user's budget.
4. Action tools execute at once from the agent wallet when the user has "Act without asking" on. Each action has a USD limit. With the setting off, an action waits for a confirmation click.
5. Funds leave the agent wallet through agent actions, or through a withdrawal to the user's sign-in address. No other destination exists on the withdrawal route.
6. When no typed tool fits, the agent writes the script or contract in its workspace, tests it on a fork, and sends it with `evm_send_transactions`.
7. A guard is a stored condition plus a stored action. The watcher is plain code. For Aave it sends the stored unwind transaction when the health factor is below the threshold. No model call is on that path.
8. Every prompt is priced above its Claude cost and charged through the MPP session.
