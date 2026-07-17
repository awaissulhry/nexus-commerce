/**
 * FP9.4 → EPF1 — the accountant interface, rewritten (D-01/D-06/D-12/D-15).
 * TWO sections in one CSV: per-INVOICE rows (VAT displayed on INVOICED
 * amounts, dated + windowed by ISSUE date in Europe/Rome — the only basis that
 * reconciles with the Fatture) and the per-ORDER rollup (operational money,
 * every column labeled with its date basis; cancelled orders carrying money
 * included, state says so). `from`/`to` are Rome-local days. Columns are
 * dropped by an EXPLICIT grain map (prices/margins) and the run is audited.
 */
import { guarded } from "@/lib/auth/guard";
import { FEATURES, FIELDS } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { toCsv } from "@/lib/csv";
import { loadOrderFinancials } from "@/lib/financials/load";
import { romeDayWindowUtc } from "@/lib/financials/rome-time";
import { buildRows, invoiceColumns, orderColumns, type ExportGrains, type InvoiceExportRow } from "@/lib/financials/export-rows";

export const permission = FEATURES.exportsRun;

export const GET = guarded(FEATURES.exportsRun, async (req, { actor, resolved }) => {
  const grains: ExportGrains = {
    prices: !!resolved && (resolved.isOwner || resolved.permissions.has(FIELDS.pricesView)),
    margins: !!resolved && (resolved.isOwner || resolved.permissions.has(FIELDS.marginsView)),
  };
  const url = new URL(req.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const window = romeDayWindowUtc(from, to);

  const [invoices, fins, vatRow] = await Promise.all([
    prisma.invoice.findMany({
      where: window ? { createdAt: window } : {},
      orderBy: { createdAt: "asc" },
      select: { number: true, amountCents: true, createdAt: true, sentAt: true, paidAt: true, order: { select: { number: true, party: { select: { name: true } } } } },
    }), // bounded: window-scoped; the no-window call matches the export's historical all-time scope (4 scalars + 2 names per row)
    loadOrderFinancials(window, { includeCancelledMoney: true }),
    prisma.appSetting.findUnique({ where: { key: "financials.defaults" } }),
  ]);
  const vatRatePct = (vatRow?.value as { vatRatePct?: number } | null)?.vatRatePct ?? 22;

  const invoiceRows: InvoiceExportRow[] = invoices.map((i) => ({
    number: i.number,
    issuedAtISO: i.createdAt.toISOString(),
    orderNumber: i.order.number,
    partyName: i.order.party.name,
    amountCents: i.amountCents,
    sentAt: i.sentAt ? i.sentAt.toISOString() : null,
    paidAt: i.paidAt ? i.paidAt.toISOString() : null,
  }));

  const sec1 = buildRows(invoiceColumns(vatRatePct), invoiceRows, grains);
  const sec2 = buildRows(orderColumns(), fins, grains);
  // section titles avoid commas — toCsv header cells are joined unescaped
  const windowLabel = `window: ${from ? from.slice(0, 10) : "start"} → ${to ? to.slice(0, 10) : "now"} (Rome days)`;
  const csv = [
    `INVOICES — VAT basis: invoiced amounts · dated by issue date (Rome) · ${windowLabel}`,
    toCsv(sec1.headers, sec1.rows).trimEnd(),
    "",
    `ORDERS — rollup per order (window on order-creation date · Rome) · each column states its basis`,
    toCsv(sec2.headers, sec2.rows).trimEnd(),
    "",
  ].join("\n");

  await audit({
    actorId: actor!.id,
    entityType: "export",
    entityId: "financials",
    action: "run",
    after: { from: from ?? null, to: to ?? null, invoiceRows: invoiceRows.length, orderRows: fins.length, prices: grains.prices, margins: grains.margins },
  });

  return new Response(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="financials.csv"' } });
});
