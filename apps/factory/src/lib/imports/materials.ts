/**
 * FP2.5 — materials CSV import (the eBay-ads dry-run idiom: parse-pure → diff →
 * apply-valid-rows). Match by name (case-insensitive): existing → update cost/
 * reorder, new → create. Costs are entered in EUROS in the CSV.
 */
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { rowsToObjects, toCsv } from "@/lib/csv";

export const MATERIAL_CSV_HEADERS = ["name", "unit", "cost_eur", "reorder_level"] as const;
const UNITS = new Set(["HIDE", "SQM", "PIECE", "M"]);

export type MaterialOp = { row: number; name: string; unit: string; costCents: number; reorderLevel: number | null };
export type MatParse = { ops: MaterialOp[]; errors: { row: number; error: string }[] };

export function parseMaterialsCsv(csv: string): MatParse {
  const ops: MaterialOp[] = [];
  const errors: { row: number; error: string }[] = [];
  const seen = new Set<string>();
  rowsToObjects(csv).forEach((obj, idx) => {
    const row = idx + 1;
    const name = (obj["name"] ?? "").trim();
    const unit = (obj["unit"] ?? "").toUpperCase().trim();
    if (!name) return errors.push({ row, error: "name is required" });
    if (!UNITS.has(unit)) return errors.push({ row, error: `unit must be HIDE|SQM|PIECE|M (got "${obj["unit"]}")` });
    const key = name.toLowerCase();
    if (seen.has(key)) return errors.push({ row, error: `duplicate name in file: ${name}` });
    seen.add(key);
    const costEur = parseFloat(obj["cost_eur"] || "0");
    if (Number.isNaN(costEur) || costEur < 0) return errors.push({ row, error: `cost_eur must be a non-negative number (got "${obj["cost_eur"]}")` });
    const reorderRaw = obj["reorder_level"]?.trim();
    const reorderLevel = reorderRaw ? Number(reorderRaw) : null;
    if (reorderRaw && (Number.isNaN(reorderLevel!) || reorderLevel! < 0)) return errors.push({ row, error: `reorder_level must be a non-negative number` });
    ops.push({ row, name, unit, costCents: Math.round(costEur * 100), reorderLevel });
  });
  return { ops, errors };
}

export type DiffRow = { row: number; action: "CREATE" | "UPDATE" | "SKIP"; target: string; from?: string; to?: string; note?: string; error?: string };

export async function diffMaterials(ops: MaterialOp[]): Promise<DiffRow[]> {
  const existing = await prisma.material.findMany({ select: { id: true, name: true, unit: true, costCents: true } });
  const byName = new Map(existing.map((m) => [m.name.toLowerCase(), m]));
  return ops.map((op) => {
    const found = byName.get(op.name.toLowerCase());
    if (!found) return { row: op.row, action: "CREATE" as const, target: `${op.name} (${op.unit})`, to: `€${(op.costCents / 100).toFixed(2)}/${op.unit}` };
    if (found.unit !== op.unit) return { row: op.row, action: "UPDATE" as const, target: op.name, from: found.unit, to: op.unit, error: "unit change needs manual review — will not apply" };
    if (found.costCents === op.costCents) return { row: op.row, action: "SKIP" as const, target: op.name, note: "unchanged" };
    return { row: op.row, action: "UPDATE" as const, target: op.name, from: `€${(found.costCents / 100).toFixed(2)}`, to: `€${(op.costCents / 100).toFixed(2)}` };
  });
}

export async function applyMaterials(ops: MaterialOp[], diff: DiffRow[], actorId: string) {
  const valid = new Map(diff.filter((d) => !d.error).map((d) => [d.row, d]));
  const results: { row: number; ok: boolean; detail: string }[] = [];
  for (const op of ops) {
    const d = valid.get(op.row);
    if (!d) { results.push({ row: op.row, ok: false, detail: "skipped (error row)" }); continue; }
    try {
      if (d.action === "SKIP") { results.push({ row: op.row, ok: true, detail: "unchanged" }); continue; }
      const existing = await prisma.material.findFirst({ where: { name: op.name }, select: { id: true } });
      if (existing) {
        await prisma.material.update({ where: { id: existing.id }, data: { costCents: op.costCents, reorderLevel: op.reorderLevel } });
        results.push({ row: op.row, ok: true, detail: `updated ${op.name}` });
      } else {
        await prisma.material.create({ data: { name: op.name, unit: op.unit, costCents: op.costCents, reorderLevel: op.reorderLevel } });
        results.push({ row: op.row, ok: true, detail: `created ${op.name}` });
      }
    } catch (err) {
      results.push({ row: op.row, ok: false, detail: (err as Error).message.slice(0, 160) });
    }
  }
  void audit({ actorId, entityType: "material", entityId: "import", action: "imported", after: { rows: results.filter((r) => r.ok).length } });
  await publishEventDurable("pricing.updated", { via: "material-import" });
  return results;
}

export function materialsTemplateCsv(): string {
  return toCsv([...MATERIAL_CSV_HEADERS], [
    ["Cowhide leather", "SQM", "40.00", "20"],
    ["Kangaroo hide", "SQM", "90.00", "5"],
    ["Thread spool", "PIECE", "3.00", "50"],
  ]);
}
