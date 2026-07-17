/**
 * F1 — factory Prisma client singleton (better-sqlite3 driver adapter).
 * WAL + busy_timeout + synchronous=NORMAL per docs/factory/F0-ARCHITECTURE.md:
 * Prisma does NOT enable WAL itself; web + worker share this one file safely
 * under WAL (one writer at a time, short write transactions). The data dir is
 * created on first open (F0-FINDINGS §14: nothing auto-creates it).
 * FS4 (S-17) — pragmas are no longer fire-and-forget: boot VERIFIES by reading
 * `journal_mode` back and logs one loud line either way (the gate report
 * quotes it). A DB that is silently NOT in WAL under two processes is
 * corruption-adjacent, so the guard refuses mutating routes until it is
 * (`mutationsBlocked()` below, consulted by src/lib/auth/guard.ts). Explicit
 * busy_timeout (belt to the adapter option's braces), 64 MB page cache, and a
 * 256 MB mmap window round out the hot-path settings — all in THIS one place.
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

const globalForPrisma = globalThis as unknown as {
  __factoryPrisma?: PrismaClient;
  /** FS4 — journal_mode read back at boot; null until verification completes */
  __factoryJournalMode?: string | null;
};

/** FS4 — verified journal mode ("wal" when healthy); null while unverified. */
export const verifiedJournalMode = (): string | null => globalForPrisma.__factoryJournalMode ?? null;

/**
 * FS4 — true only when verification COMPLETED and the answer was not WAL.
 * Unverified (boot race) does not block: refusal is for a confirmed-bad DB,
 * not for the first request beating an async PRAGMA read.
 */
export const mutationsBlocked = (): boolean => {
  const mode = verifiedJournalMode();
  return mode !== null && mode !== "wal";
};

const BUSY_TIMEOUT_MS = 5000;
const CACHE_SIZE = -64000; // KiB, negative per SQLite convention → 64 MB
const MMAP_SIZE = 268435456; // 256 MB

async function applyAndVerifyPragmas(client: PrismaClient): Promise<void> {
  try {
    await client.$queryRawUnsafe("PRAGMA journal_mode=WAL;");
    await client.$queryRawUnsafe("PRAGMA synchronous=NORMAL;");
    await client.$queryRawUnsafe(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS};`);
    await client.$queryRawUnsafe(`PRAGMA cache_size=${CACHE_SIZE};`);
    await client.$queryRawUnsafe(`PRAGMA mmap_size=${MMAP_SIZE};`);
    const rows = (await client.$queryRawUnsafe("PRAGMA journal_mode;")) as { journal_mode?: string }[];
    const mode = String(rows?.[0]?.journal_mode ?? "unknown").toLowerCase();
    globalForPrisma.__factoryJournalMode = mode;
    if (mode === "wal") {
      console.log(
        `[db] pragmas verified: journal_mode=wal · synchronous=NORMAL · busy_timeout=${BUSY_TIMEOUT_MS} · cache_size=${CACHE_SIZE} (64MB) · mmap_size=${MMAP_SIZE} (256MB)`,
      );
    } else {
      console.error(
        `[db] PRAGMA VERIFICATION FAILED — journal_mode=${mode} (expected wal). ` +
          "Two processes over a non-WAL SQLite file is corruption-adjacent: mutating routes are REFUSED (503) until the DB is back in WAL.",
      );
    }
  } catch (err) {
    // verification could not run (e.g. file lock at boot) — do NOT block writes
    // on an unknown; log loudly so the gate report sees it.
    globalForPrisma.__factoryJournalMode = null;
    console.error("[db] PRAGMA verification errored (writes NOT blocked):", (err as Error).message);
  }
}

function createClient(): PrismaClient {
  const url = factoryDbUrl();
  const filePath = url.replace(/^file:/, "");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const adapter = new PrismaBetterSqlite3({ url, timeout: BUSY_TIMEOUT_MS });
  const client = new PrismaClient({ adapter });
  void applyAndVerifyPragmas(client);
  return client;
}

export const prisma: PrismaClient = globalForPrisma.__factoryPrisma ?? createClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.__factoryPrisma = prisma;
