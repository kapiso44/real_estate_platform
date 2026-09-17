import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import * as schema from "@/db/schema";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set (copy .env.example to .env)");

// One pool per process; Next.js keeps it on globalThis so hot reload does not leak connections.
const globalForDb = globalThis as unknown as { pool?: mysql.Pool };
export const pool =
  globalForDb.pool ??
  mysql.createPool({ uri: url, connectionLimit: 10, timezone: "Z", decimalNumbers: true });
if (process.env.NODE_ENV !== "production") globalForDb.pool = pool;

export const db = drizzle(pool, { schema, mode: "default" });
