/**
 * F1 — first-run setup: ensures apps/factory/.env exists and carries a
 * generated FACTORY_ENCRYPTION_KEY (written to the file, never printed).
 * Idempotent; never overwrites existing values.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const envPath = path.join(process.cwd(), ".env");
const examplePath = path.join(process.cwd(), ".env.example");

let content = "";
if (fs.existsSync(envPath)) {
  content = fs.readFileSync(envPath, "utf8");
} else if (fs.existsSync(examplePath)) {
  content = fs.readFileSync(examplePath, "utf8");
  console.log("setup: created .env from .env.example");
}

if (/^FACTORY_ENCRYPTION_KEY=.*[0-9a-fA-F]{64}/m.test(content)) {
  console.log("setup: FACTORY_ENCRYPTION_KEY already present — leaving it alone.");
} else {
  const key = randomBytes(32).toString("hex");
  if (/^FACTORY_ENCRYPTION_KEY=/m.test(content)) {
    content = content.replace(/^FACTORY_ENCRYPTION_KEY=.*$/m, `FACTORY_ENCRYPTION_KEY=${key}`);
  } else {
    content += `\nFACTORY_ENCRYPTION_KEY=${key}\n`;
  }
  console.log("setup: generated FACTORY_ENCRYPTION_KEY and stored it in .env (value not shown).");
}

fs.writeFileSync(envPath, content, { mode: 0o600 });
console.log("setup: done. Next: npm run db:migrate && npm run db:seed && npm run bootstrap:owner (with FACTORY_OWNER_EMAIL set).");
