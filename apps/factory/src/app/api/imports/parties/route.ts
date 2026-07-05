/**
 * F1 — Party CSV import, the dry-run-diff reference: POST {csv, dryRun?}.
 * dryRun (default) returns parse errors + per-row diff and applies NOTHING;
 * apply runs only rows whose diff carries no error. Both phases persist an
 * ImportJob for the history grid.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { applyParties, diffParties, parsePartiesCsv } from "@/lib/imports/parties";

export const permission = FEATURES.importsRun;

const Body = z.object({ csv: z.string().min(1), dryRun: z.boolean().optional() });

export const POST = guarded(FEATURES.importsRun, async (req, { actor }) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "csv required" }, { status: 400 });
  const dryRun = parsed.data.dryRun !== false;

  const { ops, errors } = parsePartiesCsv(parsed.data.csv);
  const diff = await diffParties(ops);
  const errorCount = errors.length + diff.filter((d) => d.error).length;

  if (dryRun) {
    await prisma.importJob.create({
      data: {
        entity: "party",
        mode: "DRY_RUN",
        rowsTotal: ops.length + errors.length,
        rowsOk: diff.filter((d) => !d.error).length,
        rowsError: errorCount,
        diff: { parseErrors: errors, diff } as never,
        actorId: actor!.id,
      },
    });
    return NextResponse.json({ dryRun: true, parseErrors: errors, diff, applied: null });
  }

  const applied = await applyParties(ops, diff, actor!.id);
  await prisma.importJob.create({
    data: {
      entity: "party",
      mode: "APPLY",
      rowsTotal: ops.length + errors.length,
      rowsOk: applied.filter((r) => r.ok).length,
      rowsError: applied.filter((r) => !r.ok).length + errors.length,
      diff: { parseErrors: errors, diff } as never,
      result: applied as never,
      actorId: actor!.id,
    },
  });
  return NextResponse.json({ dryRun: false, parseErrors: errors, diff, applied });
});
