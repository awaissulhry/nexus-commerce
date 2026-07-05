/** FP2.5 — options CSV import into a template: dry-run diff, then apply. */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { applyOptions, diffOptions, parseOptionsCsv } from "@/lib/imports/options";

export const permission = FEATURES.productsManage;

const Body = z.object({ templateId: z.string().min(1), csv: z.string().min(1), dryRun: z.boolean().optional() });

export const POST = guarded(FEATURES.productsManage, async (req, { actor }) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "templateId and csv required" }, { status: 400 });
  const { templateId } = parsed.data;
  const template = await prisma.productTemplate.findUnique({ where: { id: templateId }, select: { id: true } });
  if (!template) return NextResponse.json({ error: "Template not found" }, { status: 404 });

  const dryRun = parsed.data.dryRun !== false;
  const { ops, errors } = parseOptionsCsv(parsed.data.csv);
  const diff = await diffOptions(templateId, ops);
  const errorCount = errors.length + diff.filter((d) => d.error).length;

  const job = (mode: "DRY_RUN" | "APPLY", result?: unknown) =>
    prisma.importJob.create({ data: { entity: "option", mode, rowsTotal: ops.length + errors.length, rowsOk: diff.filter((d) => !d.error).length, rowsError: errorCount, diff: { parseErrors: errors, diff } as never, result: result as never, actorId: actor!.id } });

  if (dryRun) { await job("DRY_RUN"); return NextResponse.json({ dryRun: true, parseErrors: errors, diff, applied: null }); }
  const applied = await applyOptions(templateId, ops, diff, actor!.id);
  await job("APPLY", applied);
  return NextResponse.json({ dryRun: false, parseErrors: errors, diff, applied });
});
