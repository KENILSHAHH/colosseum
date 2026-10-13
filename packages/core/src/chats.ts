// Stored chats. The server records each run as it streams, so a closed tab does not lose the chat.
import { sql } from "./db";
import type { AgentEvent } from "./agent/run";

export interface StoredMessage {
  role: "user" | "assistant";
  parts: any[];
  cost?: { chargedUsd: number; costUsd: number } | null;
  error?: string | null;
}

export interface ChatSummary { id: string; title: string; updatedAt: string }

const titleOf = (prompt: string) => {
  const line = prompt.replace(/\s+/g, " ").trim();
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
};

export async function listChats(userId: string): Promise<ChatSummary[]> {
  const rows = await sql()<{ id: string; title: string; updated_at: Date }[]>`
    select id, title, updated_at from chats where user_id = ${userId} order by updated_at desc limit 100`;
  return rows.map((r) => ({ id: r.id, title: r.title, updatedAt: r.updated_at.toISOString() }));
}

export async function getChat(userId: string, id: string): Promise<{ id: string; sessionId: string | null; title: string; messages: StoredMessage[] } | null> {
  const [chat] = await sql()<{ id: string; session_id: string | null; title: string }[]>`select id, session_id, title from chats where id = ${id} and user_id = ${userId}`.catch(() => []);
  if (!chat) return null;
  const rows = await sql()<{ role: "user" | "assistant"; parts: any[]; cost: StoredMessage["cost"]; error: string | null }[]>`
    select role, parts, cost, error from chat_messages where chat_id = ${chat.id} order by id`;
  return { id: chat.id, sessionId: chat.session_id, title: chat.title, messages: rows.map((r) => ({ role: r.role, parts: r.parts, cost: r.cost, error: r.error })) };
}

export async function deleteChat(userId: string, id: string): Promise<boolean> {
  const rows = await sql()`delete from chats where id = ${id} and user_id = ${userId} returning id`.catch(() => []);
  return rows.length > 0;
}

/** Records one run. It builds the same message parts that the browser builds from the event stream. */
export class ChatRecorder {
  private assistantRow: number | null = null;
  private assistant: StoredMessage = { role: "assistant", parts: [] };
  private constructor(readonly userId: string, readonly chatId: string) {}

  /** Find the chat of the session to resume, or start a new one. The prompt is stored as the first message of the run. */
  static async open(userId: string, prompt: string, resumeSessionId?: string): Promise<ChatRecorder> {
    let chatId: string | undefined;
    if (resumeSessionId) {
      const [row] = await sql()<{ id: string }[]>`select id from chats where user_id = ${userId} and session_id = ${resumeSessionId} order by updated_at desc limit 1`;
      chatId = row?.id;
    }
    chatId ??= (await sql()<{ id: string }[]>`insert into chats (user_id, session_id, title) values (${userId}, ${resumeSessionId ?? null}, ${titleOf(prompt)}) returning id`)[0]!.id;
    const rec = new ChatRecorder(userId, chatId);
    await rec.addUserMessage(prompt);
    return rec;
  }

  private async touch(sessionId?: string) {
    await sql()`update chats set updated_at = now(), session_id = coalesce(${sessionId ?? null}, session_id) where id = ${this.chatId}`;
  }

  private async addUserMessage(text: string) {
    await sql()`insert into chat_messages (chat_id, role, parts) values (${this.chatId}, 'user', ${sql().json([{ kind: "text", text }])})`;
    await this.touch();
    this.assistantRow = null;
    this.assistant = { role: "assistant", parts: [] };
  }

  /** A message that the user sent while the agent ran. The next events go into a new answer under it. */
  async midRunMessage(text: string) {
    await this.flush();
    await this.addUserMessage(text);
  }

  async flush() {
    const m = this.assistant;
    if (!m.parts.length && !m.error && !m.cost) return;
    if (this.assistantRow === null) {
      const [row] = await sql()<{ id: string }[]>`insert into chat_messages (chat_id, role, parts, cost, error) values (${this.chatId}, 'assistant', ${sql().json(m.parts)}, ${m.cost ? sql().json(m.cost) : null}, ${m.error ?? null}) returning id`;
      this.assistantRow = Number(row!.id);
    } else {
      await sql()`update chat_messages set parts = ${sql().json(m.parts)}, cost = ${m.cost ? sql().json(m.cost) : null}, error = ${m.error ?? null} where id = ${this.assistantRow}`;
    }
    await this.touch();
  }

  /** Add one event. The row is written at the end of each step, not at each token. */
  async add(ev: AgentEvent) {
    const parts = this.assistant.parts;
    if (ev.type === "session") return this.touch(ev.sessionId);
    if (ev.type === "text") {
      const last = parts[parts.length - 1];
      if (last?.kind === "text") last.text += ev.delta;
      else parts.push({ kind: "text", text: ev.delta });
    } else if (ev.type === "tool") parts.push({ kind: "tool", id: ev.id, name: ev.name, input: ev.input });
    else if (ev.type === "tool_result") {
      const p = parts.find((x) => x.kind === "tool" && x.id === ev.id);
      if (p) Object.assign(p, { result: ev.preview, isError: ev.isError });
      return this.flush();
    } else if (ev.type === "wallet_request") parts.push({ kind: "wallet_request", request: ev.request });
    else if (ev.type === "permission") parts.push({ kind: "permission", permission: ev.permission });
    else if (ev.type === "intent") {
      const i = parts.findIndex((x) => x.kind === "intent" && x.intent.id === ev.intent.id);
      if (i >= 0) parts[i] = { kind: "intent", intent: ev.intent };
      else parts.push({ kind: "intent", intent: ev.intent });
    } else if (ev.type === "done") {
      this.assistant.cost = { chargedUsd: ev.chargedUsd, costUsd: ev.costUsd };
      return this.flush();
    } else if (ev.type === "error") {
      this.assistant.error = ev.message;
      return this.flush();
    }
  }
}

/** The recorder of the run that is active for each user, so a message sent during the run is stored in order. */
export const activeRecorders = new Map<string, ChatRecorder>();
