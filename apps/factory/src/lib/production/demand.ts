/**
 * FP6 — a garment's material demand, via the FP2 engine. Reservations snapshot
 * this at production start (it is the RESERVE quantity); the board then reads
 * the RESERVE movements back rather than recomputing. The template is derived
 * from the line's selected options (option → group → template). A line with no
 * selections yields no demand (base BOM can't be resolved without the template).
 */
import { prisma } from "@/lib/db";
import { compose } from "@/lib/pricing";
import { loadEngineTemplate, loadPriceListInput } from "@/lib/products/load-engine";

export async function garmentDemand(selections: string[]): Promise<{ materialId: string; qty: number }[]> {
  if (!selections || selections.length === 0) return [];
  const opt = await prisma.option.findUnique({ where: { id: selections[0] }, select: { group: { select: { templateId: true } } } });
  const templateId = opt?.group.templateId;
  if (!templateId) return [];
  const template = await loadEngineTemplate(templateId);
  if (!template) return [];
  const result = compose({ template, selectedOptionIds: selections, priceList: await loadPriceListInput(null), adjustmentCents: 0 });
  return result.materials.map((m) => ({ materialId: m.materialId, qty: m.qty }));
}
