/** FP3.4 — quotes CSV export (margin column grain-gated, filter called explicitly). */
import { prisma } from "@/lib/db";
import { guarded } from "@/lib/auth/guard";
import { FEATURES, FIELDS } from "@/lib/auth/permissions";
import { toCsv } from "@/lib/csv";
import { quoteTotals } from "@/lib/quotes/compose-line";

export const permission = FEATURES.exportsRun;

const money = (c: number) => (c / 100).toFixed(2);

export const GET = guarded(FEATURES.exportsRun, async (_req, { resolved }) => {
  const canMargin = !!resolved && (resolved.isOwner || resolved.permissions.has(FIELDS.marginsView));
  const quotes = await prisma.quote.findMany({ // bounded: export: whole-table by design; streaming rework = FS5
    orderBy: { updatedAt: "desc" },
    include: { party: { select: { name: true } }, lines: { select: { netPriceCents: true, costCents: true, qty: true } } },
  });
  const headers = ["number", "party", "state", "net", ...(canMargin ? ["margin_pct"] : []), "deposit_pct", "valid_until", "updated"];
  const rows = quotes.map((q) => {
    const t = quoteTotals(q.lines);
    return [q.number, q.party.name, q.state, money(t.netCents), ...(canMargin ? [t.marginPct.toFixed(1)] : []), q.depositPct ?? "", q.validUntilAt ? q.validUntilAt.toISOString().slice(0, 10) : "", q.updatedAt.toISOString().slice(0, 10)];
  });
  return new Response(toCsv(headers, rows), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="quotes.csv"' } });
});
