/**
 * FP2.5 — options CSV import into a template (dry-run idiom). One row per
 * option; groups are created as needed (min/max only on group creation). Deltas
 * are entered as EUROS (ABSOLUTE) or PERCENT numbers; the mode column decides.
 */
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { rowsToObjects, toCsv } from "@/lib/csv";

export const OPTION_CSV_HEADERS = ["group", "min", "max", "option", "price_delta", "price_mode", "cost_delta", "cost_mode"] as const;

type Mode = "ABSOLUTE" | "PERCENT";
const toStore = (value: number, mode: Mode) => Math.round(value * 100); // €→cents or %→bp (both ×100)

export type OptionOp = {
  row: number;
  group: string;
  min: number;
  max: number;
  option: string;
  priceDelta: number;
  priceDeltaMode: Mode;
  costDelta: number;
  costDeltaMode: Mode;
};
export type OptParse = { ops: OptionOp[]; errors: { row: number; error: string }[] };

const asMode = (s: string | undefined): Mode | null => {
  const v = (s ?? "ABSOLUTE").toUpperCase().trim();
  return v === "ABSOLUTE" || v === "PERCENT" ? v : null;
};

export function parseOptionsCsv(csv: string): OptParse {
  const ops: OptionOp[] = [];
  const errors: { row: number; error: string }[] = [];
  const seen = new Set<string>();
  rowsToObjects(csv).forEach((obj, idx) => {
    const row = idx + 1;
    const group = (obj["group"] ?? "").trim();
    const option = (obj["option"] ?? "").trim();
    if (!group) return errors.push({ row, error: "group is required" });
    if (!option) return errors.push({ row, error: "option is required" });
    const key = `${group.toLowerCase()}::${option.toLowerCase()}`;
    if (seen.has(key)) return errors.push({ row, error: `duplicate ${group} / ${option} in file` });
    seen.add(key);
    const priceMode = asMode(obj["price_mode"]);
    const costMode = asMode(obj["cost_mode"]);
    if (!priceMode) return errors.push({ row, error: `price_mode must be ABSOLUTE or PERCENT` });
    if (!costMode) return errors.push({ row, error: `cost_mode must be ABSOLUTE or PERCENT` });
    const priceVal = parseFloat(obj["price_delta"] || "0");
    const costVal = parseFloat(obj["cost_delta"] || "0");
    if (Number.isNaN(priceVal) || Number.isNaN(costVal)) return errors.push({ row, error: "price_delta and cost_delta must be numbers" });
    const min = Number(obj["min"] || "0");
    const max = Number(obj["max"] || "1");
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < 1) return errors.push({ row, error: "min ≥ 0 and max ≥ 1 (integers)" });
    ops.push({ row, group, min, max, option, priceDelta: toStore(priceVal, priceMode), priceDeltaMode: priceMode, costDelta: toStore(costVal, costMode), costDeltaMode: costMode });
  });
  return { ops, errors };
}

export type DiffRow = { row: number; action: "CREATE" | "UPDATE" | "SKIP"; target: string; from?: string; to?: string; note?: string; error?: string };

export async function diffOptions(templateId: string, ops: OptionOp[]): Promise<DiffRow[]> {
  const groups = await prisma.optionGroup.findMany({ where: { templateId }, include: { options: true } });
  const groupByName = new Map(groups.map((g) => [g.name.toLowerCase(), g]));
  const fmt = (v: number, m: Mode) => (m === "ABSOLUTE" ? `€${(v / 100).toFixed(2)}` : `${v / 100}%`);
  return ops.map((op) => {
    const g = groupByName.get(op.group.toLowerCase());
    const groupNote = g ? undefined : `new group "${op.group}"`;
    const existingOpt = g?.options.find((o) => o.name.toLowerCase() === op.option.toLowerCase());
    if (!existingOpt) return { row: op.row, action: "CREATE" as const, target: `${op.group}: ${op.option}`, to: `price ${fmt(op.priceDelta, op.priceDeltaMode)}`, note: groupNote };
    const changed = existingOpt.priceDelta !== op.priceDelta || existingOpt.priceDeltaMode !== op.priceDeltaMode || existingOpt.costDelta !== op.costDelta || existingOpt.costDeltaMode !== op.costDeltaMode;
    if (!changed) return { row: op.row, action: "SKIP" as const, target: `${op.group}: ${op.option}`, note: "unchanged" };
    return { row: op.row, action: "UPDATE" as const, target: `${op.group}: ${op.option}`, from: fmt(existingOpt.priceDelta, existingOpt.priceDeltaMode as Mode), to: fmt(op.priceDelta, op.priceDeltaMode) };
  });
}

export async function applyOptions(templateId: string, ops: OptionOp[], diff: DiffRow[], actorId: string) {
  const valid = new Map(diff.filter((d) => !d.error).map((d) => [d.row, d]));
  const results: { row: number; ok: boolean; detail: string }[] = [];
  // resolve/create groups first (dedupe by name), respecting existing sort
  const groups = await prisma.optionGroup.findMany({ where: { templateId } });
  const groupByName = new Map(groups.map((g) => [g.name.toLowerCase(), g]));
  let nextGroupSort = groups.reduce((m, g) => Math.max(m, g.sort), -1) + 1;
  for (const op of ops) {
    if (!valid.has(op.row)) continue;
    if (!groupByName.has(op.group.toLowerCase())) {
      const created = await prisma.optionGroup.create({ data: { templateId, name: op.group, minSelect: op.min, maxSelect: op.max, sort: nextGroupSort++ } });
      groupByName.set(op.group.toLowerCase(), { ...created, options: [] } as never);
    }
  }
  for (const op of ops) {
    const d = valid.get(op.row);
    if (!d) { results.push({ row: op.row, ok: false, detail: "skipped (error row)" }); continue; }
    try {
      if (d.action === "SKIP") { results.push({ row: op.row, ok: true, detail: "unchanged" }); continue; }
      const g = groupByName.get(op.group.toLowerCase())!;
      const existing = await prisma.option.findFirst({ where: { groupId: g.id, name: { equals: op.option } }, select: { id: true } });
      const data = { name: op.option, priceDelta: op.priceDelta, priceDeltaMode: op.priceDeltaMode, costDelta: op.costDelta, costDeltaMode: op.costDeltaMode };
      if (existing) {
        await prisma.option.update({ where: { id: existing.id }, data });
        results.push({ row: op.row, ok: true, detail: `updated ${op.option}` });
      } else {
        const last = await prisma.option.findFirst({ where: { groupId: g.id }, orderBy: { sort: "desc" }, select: { sort: true } });
        await prisma.option.create({ data: { groupId: g.id, sort: (last?.sort ?? -1) + 1, ...data } });
        results.push({ row: op.row, ok: true, detail: `created ${op.option}` });
      }
    } catch (err) {
      results.push({ row: op.row, ok: false, detail: (err as Error).message.slice(0, 160) });
    }
  }
  void audit({ actorId, entityType: "template", entityId: templateId, action: "options.imported", after: { rows: results.filter((r) => r.ok).length } });
  await publishEventDurable("pricing.updated", { templateId });
  return results;
}

export function optionsTemplateCsv(): string {
  return toCsv([...OPTION_CSV_HEADERS], [
    ["Leather type", "1", "1", "Cowhide", "0", "ABSOLUTE", "0", "ABSOLUTE"],
    ["Leather type", "1", "1", "Kangaroo", "120.00", "ABSOLUTE", "80.00", "ABSOLUTE"],
    ["Perforation", "0", "1", "Perforated panels", "5", "PERCENT", "10.00", "ABSOLUTE"],
  ]);
}
