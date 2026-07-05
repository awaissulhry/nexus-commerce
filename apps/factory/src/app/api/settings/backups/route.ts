/**
 * FP11.3 — the worker's nightly SQLite snapshots (VACUUM INTO .snapshots/,
 * rotated 14). Read-only: local-first means the Owner IS the ops team, so the
 * backups are visible. Restore is a documented one-liner, not a click (too sharp
 * to press by accident over a live DB).
 */
import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { guarded } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";
import { factoryDbUrl } from "@/lib/db";

export const permission = PAGES.settings;

export const GET = guarded(PAGES.settings, async () => {
  const dbFile = factoryDbUrl().replace(/^file:/, "");
  const dir = path.join(path.dirname(dbFile), "..", ".snapshots");
  let backups: { name: string; sizeBytes: number; modifiedAt: string }[] = [];
  try {
    if (fs.existsSync(dir)) {
      backups = fs
        .readdirSync(dir)
        .filter((f) => f.startsWith("factory-") && f.endsWith(".db"))
        .map((name) => { const st = fs.statSync(path.join(dir, name)); return { name, sizeBytes: st.size, modifiedAt: st.mtime.toISOString() }; })
        .sort((a, b) => (a.name < b.name ? 1 : -1));
    }
  } catch { /* a missing/locked snapshots dir just means "none yet" */ }
  return NextResponse.json({ backups, dir });
});
