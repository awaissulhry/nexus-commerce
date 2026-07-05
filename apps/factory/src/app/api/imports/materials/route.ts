/** FP2.5 — materials CSV import: dry-run diff, then apply-valid-rows. */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { applyMaterials, diffMaterials, parseMaterialsCsv } from "@/lib/imports/materials";

export const permission = FEATURES.materialsManage;

const Body = z.object({ csv: z.string().min(1), dryRun: z.boolean().optional() });

export const POST = guarded(FEATURES.materialsManage, async (req, { actor }) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "csv required" }, { status: 400 });
  const dryRun = parsed.data.dryRun !== false;
  const { ops, errors } = parseMaterialsCsv(parsed.data.csv);
  const diff = await diffMaterials(ops);
  const errorCount = errors.length + diff.filter((d) => d.error).length;

  const job = (mode: "DRY_RUN" | "APPLY", result?: unknown) =>
    prisma.importJob.create({ data: { entity: "material", mode, rowsTotal: ops.length + errors.length, rowsOk: diff.filter((d) => !d.error).length, rowsError: errorCount, diff: { parseErrors: errors, diff } as never, result: result as never, actorId: actor!.id } });

  if (dryRun) { await job("DRY_RUN"); return NextResponse.json({ dryRun: true, parseErrors: errors, diff, applied: null }); }
  const applied = await applyMaterials(ops, diff, actor!.id);
  await job("APPLY", applied);
  return NextResponse.json({ dryRun: false, parseErrors: errors, diff, applied });
});
