/**
 * Database access for the CLI scripts.
 *
 * The Next.js app uses src/lib/db.ts with the "@/..." path alias, which only the bundler
 * resolves. Scripts run straight through Node (type stripping), so they use relative
 * imports and their own short-lived pool.
 */
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import * as schema from "../src/db/schema.ts";

export { schema };

export function connect() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set — run scripts through npm (node --env-file=.env)");
  const pool = mysql.createPool({ uri: url, connectionLimit: 5, timezone: "Z", decimalNumbers: true });
  const db = drizzle(pool, { schema, mode: "default" });
  return { db, pool };
}

/** Splits a list into chunks so a single INSERT does not exceed max_allowed_packet. */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
