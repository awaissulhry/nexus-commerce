/**
 * F1 — factory Prisma client singleton (better-sqlite3 driver adapter).
 * WAL + busy_timeout + synchronous=NORMAL per docs/factory/F0-ARCHITECTURE.md:
 * Prisma does NOT enable WAL itself; web + worker share this one file safely
 * under WAL (one writer at a time, short write transactions). The data dir is
 * created on first open (F0-FINDINGS §14: nothing auto-creates it).
 */
import fs from "node:fs";
import path from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@/generated/prisma/client";

export function factoryDbUrl(): string {
  // `||` not `??`: .env templates ship `FACTORY_DATABASE_URL=` (empty string),
  // which must fall through to the default path, not open a nameless DB.
  return (
    process.env.FACTORY_DATABASE_URL ||
    `file:${path.join(process.cwd(), "data", "factory.db")}`
  );
}

function createClient(): PrismaClient {
  const url = factoryDbUrl();
  const filePath = url.replace(/^file:/, "");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const adapter = new PrismaBetterSqlite3({ url, timeout: 5000 });
  const client = new PrismaClient({ adapter });
  // Fire-and-forget pragmas: WAL persists on the file; NORMAL is per-connection.
  void client.$queryRawUnsafe("PRAGMA journal_mode=WAL;").catch(() => {});
  void client.$queryRawUnsafe("PRAGMA synchronous=NORMAL;").catch(() => {});
  return client;
}

const globalForPrisma = globalThis as unknown as { __factoryPrisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma.__factoryPrisma ?? createClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.__factoryPrisma = prisma;
