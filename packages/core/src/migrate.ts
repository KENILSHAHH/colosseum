import { migrate, sql } from "./db";

await migrate();
console.log("Schema is up to date.");
await sql().end();
