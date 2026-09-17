import { defineConfig } from "drizzle-kit";

// drizzle-kit runs as its own binary, so npm scripts start it through
// `node --env-file=.env` to get DATABASE_URL into the environment.
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set (copy .env.example to .env)");

export default defineConfig({
  dialect: "mysql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url },
});
