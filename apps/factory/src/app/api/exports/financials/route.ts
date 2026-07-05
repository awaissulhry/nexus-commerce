/**
 * FP9.4 — the accountant interface: a period CSV of every order's money with
 * net / VAT (display) / gross. Margin columns are grain-gated (financials.margins
 * .view) — the commercialista gets the tax figures; margin stays the Owner's.
 */
import { guarded } from "@/lib/auth/guard";
import { FEATURES, FIELDS } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db";
import { toCsv } from "@/lib/csv";
import { vatDisplay } from "@/lib/financials/rollup";
import { loadOrderFinancials } from "@/lib/financials/load";

export const permission = FEATURES.exportsRun;

export const GET = guarded(FEATURES.exportsRun, async (req, { resolved }) => {
  const canMargin = !!resolved && (resolved.isOwner || resolved.permissions.has(FIELDS.marginsView));
  const url = new URL(req.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const createdAt = from || to ? { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } : undefined;

  const fins = await loadOrderFinancials(createdAt);
  const vatRow = await prisma.appSetting.findUnique({ where: { key: "financials.defaults" } });
  const vatRatePct = (vatRow?.value as { vatRatePct?: number } | null)?.vatRatePct ?? 22;
  const e = (c: number) => (c / 100).toFixed(2);

  const headers = ["order", "customer", "month", "state", "net", "invoiced", "paid", "balance", "vat_rate", "vat", "gross", ...(canMargin ? ["est_margin", "actual_margin"] : [])];
  const rows = fins.map((f) => {
    const v = vatDisplay(f.quotedNetCents, vatRatePct);
    return [f.number, f.partyName, f.monthKey, f.state, e(f.quotedNetCents), e(f.invoicedCents), e(f.paidCents), e(f.balanceCents), `${vatRatePct}%`, e(v.vatCents), e(v.grossCents), ...(canMargin ? [e(f.estMarginCents), e(f.actualMarginCents)] : [])];
  });
  return new Response(toCsv(headers, rows), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="financials.csv"' } });
});
