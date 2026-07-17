/**
 * EPO.7b — historical-order CSV import: POST {csv, dryRun?} on the house
 * dry-run-diff idiom (parties import is the reference). dryRun (default)
 * returns parse errors + per-row diff and applies NOTHING; apply runs only
 * rows whose diff carries no error. Imported orders publish ONE
 * import.finished event (the FS2/M6 handoff) — boards refresh once.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { publishEventDurable } from "@/lib/events";
import { applyOrders, diffOrders, parseOrdersCsv } from "@/lib/imports/orders";

export const permission = FEATURES.importsRun;

const Body = z.object({ csv: z.string().min(1), dryRun: z.boolean().optional() });

export const POST = guarded(FEATURES.importsRun, async (req, { actor }) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "csv required" }, { status: 400 });
  const dryRun = parsed.data.dryRun !== false;

  const { ops, errors } = parseOrdersCsv(parsed.data.csv);
  const diff = await diffOrders(ops);
  const errorCount = errors.length + diff.filter((d) => d.error).length;

  if (dryRun) return NextResponse.json({ dryRun: true, rows: ops.length, errors, diff, errorCount });

  const { created } = await applyOrders(ops, diff, actor!.id);
  await publishEventDurable("import.finished", { kind: "orders", created });
  return NextResponse.json({ dryRun: false, rows: ops.length, errors, diff, errorCount, created });
});
