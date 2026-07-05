/**
 * F1 — Prisma 7 config for the factory's OWN SQLite database (fully separate
 * from packages/database, which is Postgres/Neon for commerce). Prisma 7:
 * env files are not auto-loaded (dotenv import below), the datasource url no
 * longer lives in schema.prisma, and Migrate drives the JS schema engine
 * through the same better-sqlite3 driver adapter the app uses. The env var is
 * FACTORY_DATABASE_URL — DATABASE_URL is claimed by the commerce DB. CLI
 * commands run with CWD = apps/factory (npm workspace scripts), so the
 * default resolves to apps/factory/data/factory.db.
 */
import "dotenv/config";
import path from "node:path";
import { defineConfig } from "prisma/config";

// `||` not `??`: empty-string env values (from the .env template) must fall
// through to the default path.
const url =
  process.env.FACTORY_DATABASE_URL ||
  `file:${path.join(process.cwd(), "data", "factory.db")}`;
process.env.FACTORY_DATABASE_URL = url;

export default defineConfig({
  // Classic (stable) Schema Engine for Migrate; the app's runtime client uses
  // the better-sqlite3 driver adapter independently (src/lib/db.ts).
  engine: "classic",
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: { url },
});
