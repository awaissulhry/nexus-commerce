/**
 * EPO.7b — historical-order CSV import (the FP4-deferred migration path for
 * pre-platform records), on the house dry-run idiom: parse (pure) → diff
 * (db checks, per-row error/note) → apply (valid rows only). One CSV row =
 * one order with a single line — the honest v1 shape for history books.
 * Imported orders have no originating quote, so the FD13 gate is off — the
 * EPO.1 depositTermsMissing surface says so on each one. `createdAt` is taken
 * from the sheet so period rollups stay truthful.
 */
import { prisma } from "@/lib/db";
import { rowsToObjects } from "@/lib/csv";
import { nextNumberTx } from "@/lib/counters";
import { audit } from "@/lib/audit";

const STATES = new Set(["CONFIRMED", "IN_PRODUCTION", "READY", "SHIPPED", "DELIVERED", "CLOSED", "CANCELLED"]);

export type OrderOp = {
  row: number;
  partyName: string;
  description: string;
  qty: number;
  netPriceCents: number;
  costCents: number;
  state: string;
  confirmedAt: Date;
  promiseAt: Date | null;
  number: string | null; // blank ⇒ minted ORD-n on apply
  clientRef: string | null;
};

export type ParseResult = { ops: OrderOp[]; errors: { row: number; error: string }[] };

const euros = (s: string): number | null => {
  if (s.trim() === "") return 0;
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
};
const day = (s: string): Date | null | undefined => {
  if (s.trim() === "") return undefined; // absent
  const d = new Date(`${s.trim()}T12:00:00`);
  return Number.isNaN(d.getTime()) ? null : d; // null = invalid
};

export function parseOrdersCsv(csv: string): ParseResult {
  const ops: OrderOp[] = [];
  const errors: { row: number; error: string }[] = [];
  const rows = rowsToObjects(csv);
  rows.forEach((r, i) => {
    const row = i + 2; // 1-based + header
    const partyName = (r.party ?? "").trim();
    const description = (r.description ?? "").trim();
    const qty = parseInt((r.qty ?? "1").trim() || "1", 10);
    const net = euros(r.unit_net_eur ?? "");
    const cost = euros(r.unit_cost_eur ?? "");
    const state = ((r.state ?? "").trim() || "CLOSED").toUpperCase();
    const confirmed = day(r.confirmed_date ?? "");
    const promise = day(r.promise_date ?? "");
    if (!partyName) return errors.push({ row, error: "party is required" });
    if (!description) return errors.push({ row, error: "description is required" });
    if (!Number.isFinite(qty) || qty <= 0) return errors.push({ row, error: "qty must be a positive number" });
    if (net == null) return errors.push({ row, error: "unit_net_eur is not a number" });
    if (cost == null) return errors.push({ row, error: "unit_cost_eur is not a number" });
    if (!STATES.has(state)) return errors.push({ row, error: `state must be one of ${[...STATES].join("/")}` });
    if (confirmed === null) return errors.push({ row, error: "confirmed_date is not a date (YYYY-MM-DD)" });
    if (promise === null) return errors.push({ row, error: "promise_date is not a date (YYYY-MM-DD)" });
    ops.push({
      row,
      partyName,
      description,
      qty,
      netPriceCents: net,
      costCents: cost,
      state,
      confirmedAt: confirmed ?? new Date(),
      promiseAt: promise ?? null,
      number: (r.number ?? "").trim() || null,
      clientRef: (r.client_ref ?? "").trim() || null,
    });
  });
  return { ops, errors };
}

export type DiffRow = { row: number; note: string; error?: string; partyId?: string };

/** DB checks: the party must exist by exact name (import parties first); explicit numbers must be free. */
export async function diffOrders(ops: OrderOp[]): Promise<DiffRow[]> {
  const names = [...new Set(ops.map((o) => o.partyName))];
  const parties = names.length
    ? await prisma.party.findMany({ where: { name: { in: names }, archivedAt: null }, select: { id: true, name: true } }) // bounded: names from the sheet
    : [];
  const byName = new Map(parties.map((p) => [p.name, p.id]));
  const numbers = ops.map((o) => o.number).filter(Boolean) as string[];
  const taken = numbers.length
    ? new Set((await prisma.order.findMany({ where: { number: { in: numbers } }, select: { number: true } })).map((o) => o.number)) // bounded: sheet numbers
    : new Set<string>();
  const seen = new Set<string>();
  return ops.map((o) => {
    const partyId = byName.get(o.partyName);
    if (!partyId) return { row: o.row, note: "", error: `party "${o.partyName}" not found — import parties first` };
    if (o.number) {
      if (taken.has(o.number)) return { row: o.row, note: "", error: `number ${o.number} already exists` };
      if (seen.has(o.number)) return { row: o.row, note: "", error: `number ${o.number} repeats in the sheet` };
      seen.add(o.number);
    }
    return { row: o.row, partyId, note: `create ${o.number ?? "ORD-(next)"} · ${o.partyName} · ${o.description} ×${o.qty} · ${o.state}` };
  });
}

export async function applyOrders(ops: OrderOp[], diff: DiffRow[], actorId: string): Promise<{ created: number }> {
  let created = 0;
  for (let i = 0; i < ops.length; i++) {
    const o = ops[i];
    const d = diff[i];
    if (!d || d.error || !d.partyId) continue;
    await prisma.$transaction(async (tx) => {
      const number = o.number ?? (await nextNumberTx(tx, "order"));
      const order = await tx.order.create({
        data: {
          number,
          partyId: d.partyId!,
          state: o.state as never,
          createdAt: o.confirmedAt,
          promiseDateAt: o.promiseAt,
          originalPromiseDateAt: o.promiseAt, // history: the recorded promise IS the first promise
          clientRef: o.clientRef,
          lines: { create: { description: o.description, qty: o.qty, netPriceCents: o.netPriceCents, costCents: o.costCents } },
        },
        select: { id: true },
      });
      await tx.auditLog.create({
        data: { actorId, entityType: "order", entityId: order.id, action: "imported", after: { number, row: o.row, state: o.state } },
      });
    });
    created++;
  }
  void audit({ actorId, entityType: "import", entityId: "orders", action: "ran", after: { rows: ops.length, created } });
  return { created };
}

export function ordersTemplateCsv(): string {
  return [
    "party,description,qty,unit_net_eur,unit_cost_eur,state,confirmed_date,promise_date,number,client_ref",
    'Aireon,"Leather jacket — custom",10,450.00,260.00,CLOSED,2025-11-03,2025-12-01,,PO-2025-114',
  ].join("\n");
}
