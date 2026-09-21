import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { config } from "./config";

let client: postgres.Sql | undefined;

export function sql(): postgres.Sql {
  client ??= postgres(config().DATABASE_URL, { max: 10, onnotice: () => {} });
  return client;
}

export async function migrate() {
  const schema = readFileSync(fileURLToPath(new URL("./schema.sql", import.meta.url)), "utf8");
  await sql().unsafe(schema);
}

export async function ensureUser(id: string) {
  await sql()`insert into users (id) values (${id}) on conflict do nothing`;
}
