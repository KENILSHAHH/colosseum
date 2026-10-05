// Sign in with a throwaway key and send one prompt. Usage: tsx scripts/smoke-chat.mts "your prompt"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
const api = process.env.API_URL ?? "http://localhost:8787";
const acct = privateKeyToAccount(generatePrivateKey());
const post = (p: string, body: unknown, token?: string) =>
  fetch(api + p, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
const n = await (await post("/auth/nonce", { address: acct.address })).json();
const { token } = await (await post("/auth/verify", { address: acct.address, nonce: n.nonce, signature: await acct.signMessage({ message: n.message }) })).json();
const res = await post("/chat", { prompt: process.argv[2] ?? "What is the best USDC lending rate across my chains right now?" }, token);
console.log("status", res.status);
const reader = res.body!.getReader();
const dec = new TextDecoder();
let buf = "";
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let i;
  while ((i = buf.indexOf("\n\n")) >= 0) {
    const line = buf.slice(0, i).replace(/^data: /, "");
    buf = buf.slice(i + 2);
    const ev = JSON.parse(line);
    if (ev.type === "text") process.stdout.write(ev.delta);
    else console.log(`\n[${ev.type}]`, JSON.stringify(ev).slice(0, 400));
  }
}
