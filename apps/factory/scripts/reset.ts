/**
 * F1 — dev reset: delete the SQLite file (+wal/shm), re-apply migrations,
 * re-seed. DESTRUCTIVE by design and dev-only; refuses to run unless
 * FACTORY_ALLOW_RESET=1 to prevent an accidental wipe of real factory data.
 */
import "dotenv/config";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

if (process.env.FACTORY_ALLOW_RESET !== "1") {
  console.error("reset: refusing — set FACTORY_ALLOW_RESET=1 to confirm you want to DELETE the factory database.");
  process.exit(1);
}

const url = process.env.FACTORY_DATABASE_URL || `file:${path.join(process.cwd(), "data", "factory.db")}`;
const file = url.replace(/^file:/, "");
for (const suffix of ["", "-wal", "-shm"]) {
  const p = file + suffix;
  if (fs.existsSync(p)) {
    fs.rmSync(p);
    console.log(`reset: removed ${path.basename(p)}`);
  }
}
execSync("npx prisma migrate deploy", { stdio: "inherit" });
execSync("npx tsx scripts/seed.ts", { stdio: "inherit" });
console.log("reset: done.");
