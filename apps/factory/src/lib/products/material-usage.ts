/**
 * FP2.3 — how many templates reference each material (via base BOM lines OR via
 * per-option material draws). Powers the Materials grid "used by N" column and
 * the FP2.5 reprice-ripple banner. Draws live in Option.materialDraws JSON, so
 * they need an in-memory scan — cheap at factory scale.
 */
import { prisma } from "@/lib/db";

export async function allMaterialUsage(): Promise<Map<string, Set<string>>> {
  const usage = new Map<string, Set<string>>();
  const add = (materialId: string, templateId: string) => {
    let set = usage.get(materialId);
    if (!set) usage.set(materialId, (set = new Set()));
    set.add(templateId);
  };

  const [bomLines, options] = await Promise.all([
    prisma.bomLine.findMany({ select: { materialId: true, templateId: true } }),
    prisma.option.findMany({
      where: { materialDraws: { not: undefined } },
      select: { materialDraws: true, group: { select: { templateId: true } } },
    }),
  ]);

  for (const b of bomLines) add(b.materialId, b.templateId);
  for (const o of options) {
    const draws = (o.materialDraws as { materialId?: string }[] | null) ?? [];
    if (!Array.isArray(draws)) continue;
    for (const d of draws) if (d?.materialId) add(d.materialId, o.group.templateId);
  }
  return usage;
}

/** Template ids referencing a single material (for the ripple banner). */
export async function materialUsage(materialId: string): Promise<string[]> {
  const all = await allMaterialUsage();
  return [...(all.get(materialId) ?? [])];
}
