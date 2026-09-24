export class HttpError extends Error {
  constructor(
    public url: string,
    public status: number,
    public body: string,
  ) {
    super(`HTTP ${status} from ${url}: ${body.slice(0, 300)}`);
  }
}

export async function getJson<T>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const { timeoutMs = 15_000, ...rest } = init;
  const res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok) throw new HttpError(url, res.status, text);
  return JSON.parse(text) as T;
}

export function postJson<T>(url: string, body: unknown, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  return getJson<T>(url, {
    ...init,
    method: "POST",
    headers: { "content-type": "application/json", ...init.headers },
    body: JSON.stringify(body),
  });
}
