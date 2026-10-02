/**
 * P11 — the FIRST import of the factory's stdio MCP server (server.ts). Its body runs before any other module of the
 * server is evaluated:
 *
 *   · stdout belongs to the MCP protocol (one JSON-RPC message per line). The factory's modules log to the console —
 *     db.ts prints its pragma check on stdout — and one stray line would break the connection. Every console method
 *     writes to stderr from here on, which Claude shows as the server's log.
 *   · Claude starts the server from its own working directory, not the factory's: the factory's .env is read by path,
 *     and the database defaults to the factory's own file (apps/factory/data/factory.db), as the app's does.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

export const FACTORY_APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

for (const method of ["log", "info", "debug", "warn"] as const) {
  console[method] = (...args: unknown[]) => console.error(...args);
}

// Values already in the environment (the Claude configuration) win over the file.
dotenv.config({ path: path.join(FACTORY_APP_DIR, ".env"), quiet: true });
process.env.FACTORY_DATABASE_URL ||= `file:${path.join(FACTORY_APP_DIR, "data", "factory.db")}`;
