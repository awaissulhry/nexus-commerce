/**
 * One-shot eBay access-token refresh.
 *
 * Identical code path to the background cron — exists so an operator
 * can force a refresh after downtime (or after the cron was disabled
 * in production) without waiting for the next 30-min tick. Idempotent;
 * leaves still-valid tokens untouched.
 *
 *   tsx apps/api/scripts/refresh-ebay-tokens.ts
 */

import { config } from "dotenv";
import { runRefreshSweep } from "../src/jobs/ebay-token-refresh.job.js";

config();

await runRefreshSweep();

// Cron sweep keeps no open handles; force-exit to be safe in case
// future Prisma/HTTP keepalives leak into the script's lifetime.
process.exit(0);
