export interface Intent {
  id: string;
  kind: string;
  params: Record<string, any>;
  preview: Record<string, any>;
  status: "pending" | "confirmed" | "executing" | "done" | "failed" | "rejected" | "expired";
  feeUsd: number;
  result: Record<string, any> | null;
  createdAt: string;
}

export type AgentEvent =
  | { type: "session"; sessionId: string; skills: string[] }
  | { type: "text"; delta: string }
  | { type: "tool"; id: string; name: string; input: any }
  | { type: "tool_result"; id: string; isError: boolean; preview: string }
  | { type: "intent"; intent: Intent }
  | { type: "permission"; permission: Permission }
  | { type: "charged"; amountUsd: number }
  | { type: "done"; costUsd: number; chargedUsd: number; turns: number; stopReason: string }
  | { type: "error"; message: string };

export interface Permission {
  id: string;
  owner: string;
  chain: string;
  chainId: number;
  chainName: string;
  targets: string[];
  functions: string[];
  maxValueWei: string;
  expiresAt: string;
  reason: string;
  status: "pending" | "active" | "rejected" | "removed";
  warnings: string[];
}

export interface Me {
  address: string;
  linkedWallet: string | null;
  /** The Privy wallet of the user. Tokens that arrive there convert to OUSD on Tempo when `enabled` is true. */
  deposit: { address: string | null; enabled: boolean; signerId: string | null } | null;
  wallet: { address: string; autoExecute: boolean; maxActionUsd: number };
  pricing: { promptUsd: number; actionUsd: number; guardMinuteUsd: number };
  mppEnabled: boolean;
}

const TOKEN_KEY = "defi-agent-token";

export const token = {
  get: () => (typeof window === "undefined" ? null : window.localStorage.getItem(TOKEN_KEY)),
  set: (t: string) => window.localStorage.setItem(TOKEN_KEY, t),
  clear: () => window.localStorage.removeItem(TOKEN_KEY),
};

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const t = token.get();
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(t ? { authorization: `Bearer ${t}` } : {}), ...init.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error ?? `Request failed (${res.status})`);
  return body as T;
}

export const post = <T>(path: string, body: unknown = {}) => api<T>(path, { method: "POST", body: JSON.stringify(body) });

/** Send a prompt and read the event stream. */
export async function* chat(prompt: string, sessionId: string | null, signal: AbortSignal): AsyncGenerator<AgentEvent> {
  const t = token.get();
  const res = await fetch("/api/chat", {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", ...(t ? { authorization: `Bearer ${t}` } : {}) },
    body: JSON.stringify({ prompt, sessionId: sessionId ?? undefined }),
  });
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error ?? `Request failed (${res.status})`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut: number;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
      if (data) yield JSON.parse(data) as AgentEvent;
    }
  }
}

export const usd = (n: number, digits = 2) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: n !== 0 && Math.abs(n) < 0.01 ? 4 : digits });

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export interface Positions {
  address: string;
  asOf: string;
  balances: { chain: string; chainName: string; eth: number | null; usdc: number | null; error: string | null }[];
  hyperliquid: {
    accounts: { dex: string; accountValue: number; marginUsed: number; withdrawable: number }[];
    positions: { coin: string; dex: string; size: number; entryPx: number; markPx: number; liquidationPx: number | null; distanceToLiquidation: number | null; leverage: number; marginUsed: number; unrealizedPnl: number; positionValue: number }[];
  };
  aave: { chain: string; chainKey: string; collateralUsd: number; debtUsd: number; healthFactor: number | null; ltv: number; liquidationThreshold: number }[];
  aaveV4: { chain: string; spoke: string; suppliedUsd: number; collateralUsd: number; debtUsd: number; healthFactor: number | null; netApyPct: number }[];
  guards: { id: string; venue: string; params: Record<string, any>; status: string; lastValue: number | null; lastCheck: string | null }[];
  errors: string[];
}
