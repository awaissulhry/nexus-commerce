/**
 * Environment loading, isolated in its own module so import ORDER can
 * guarantee it runs before anything that reads process.env at module
 * scope. ESM evaluates a module's imports depth-first BEFORE its body:
 * db.ts calling dotenv config() in its body is too late for
 * @nexus/database, whose pg Pool captures DATABASE_URL at import time.
 * Importing './env.js' as the FIRST import of db.ts closes that gap —
 * this body executes before @nexus/database is evaluated.
 *
 * Loads (non-overriding, in order): process cwd .env via dotenv/config
 * semantics, then the repo-root .env that holds DATABASE_URL + channel
 * credentials for local runs. On Railway both are absent and platform
 * env vars win untouched.
 */
import { resolve } from "path";
import { config } from "dotenv";

config();
config({ path: resolve(new URL(".", import.meta.url).pathname, "../../../.env") });

// Each workspace query owns a transaction and several database round trips.
// The API also runs workers and crons; one shared connection queues interactive
// requests behind that work. Web/serverless consumers retain the library's default of one.
process.env.NEXUS_DATABASE_POOL_MAX ??= '8';
