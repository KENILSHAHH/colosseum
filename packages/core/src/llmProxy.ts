// Local proxy between the agent subprocess and the Claude API.
// The subprocess gets a short-lived session token, not the real key. The proxy checks the token and the
// user's budget, then adds the real key. A terminal command inside the agent cannot read the key.
// Pattern: https://code.claude.com/docs/en/agent-sdk/secure-deployment#the-proxy-pattern
import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";
import { checkBudget } from "./billing/pricing";
import { config } from "./config";
import { signToken, verifyToken } from "./crypto";

const UPSTREAM = "https://api.anthropic.com";
const HOP_HEADERS = new Set(["host", "connection", "content-length", "x-api-key", "authorization", "accept-encoding"]);

export function llmSessionToken(userId: string): string {
  return signToken({ sub: userId, aud: "llm" }, 3600);
}

export function startLlmProxy(port = config().LLM_PROXY_PORT): Server {
  const server = createServer(async (req, res) => {
    try {
      const token = (req.headers["x-api-key"] as string | undefined) ?? (req.headers.authorization ?? "").replace(/^Bearer /, "");
      const claims = verifyToken<{ sub: string; aud: string }>(token);
      if (!claims || claims.aud !== "llm") {
        res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid session token" } }));
        return;
      }
      const budget = await checkBudget(claims.sub);
      if (!budget.ok) {
        res.writeHead(429, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: budget.reason } }));
        return;
      }
      const apiKey = config().ANTHROPIC_API_KEY;
      if (!apiKey) {
        // 401 is not retried by the client. The error reaches the user at once.
        res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "ANTHROPIC_API_KEY is not set on the server." } }));
        return;
      }

      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (!HOP_HEADERS.has(k) && typeof v === "string") headers.set(k, v);
      }
      headers.set("x-api-key", apiKey);

      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const upstream = await fetch(`${UPSTREAM}${req.url}`, {
        method: req.method,
        headers,
        body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
        // @ts-expect-error Node needs `duplex` for a streamed request body.
        duplex: "half",
      });
      const out: Record<string, string> = {};
      upstream.headers.forEach((v, k) => {
        if (k !== "content-encoding" && k !== "content-length" && k !== "transfer-encoding") out[k] = v;
      });
      res.writeHead(upstream.status, out);
      if (upstream.body) Readable.fromWeb(upstream.body as never).pipe(res);
      else res.end();
    } catch (err) {
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: err instanceof Error ? err.message : "proxy failure" } }));
    }
  });
  // Loopback only. The proxy is not reachable from the network.
  server.listen(port, "127.0.0.1");
  return server;
}
