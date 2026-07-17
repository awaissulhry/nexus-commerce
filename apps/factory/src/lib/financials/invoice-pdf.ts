/**
 * EPF1.1 (D-05/D-17) — render + store an invoice's Fattura PDF AFTER the
 * money row is committed. The invoice row is the truth; the PDF is derived
 * output — a render failure leaves `pdfRef` null and `GET /api/invoices/[id]`
 * calls this again on demand (the repair path). The rendered date is the
 * invoice's own createdAt, so a re-render is byte-stable in content.
 */
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../db";
import { renderInvoicePdf } from "./render-invoice";

/**
 * Render the PDF for an existing invoice and persist it beside the DB.
 * Returns the stored path, or null when the invoice is missing or the render
 * fails (logged; the caller decides whether that is a 404/500 or a shrug).
 */
export async function renderAndStoreInvoicePdf(invoiceId: string): Promise<string | null> {
  try {
    const inv = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: {
        id: true,
        number: true,
        amountCents: true,
        createdAt: true,
        order: {
          select: {
            number: true,
            party: { select: { name: true } },
            lines: { select: { description: true, qty: true, netPriceCents: true } },
          },
        },
      },
    });
    if (!inv) return null;

    const vatRow = await prisma.appSetting.findUnique({ where: { key: "financials.defaults" } });
    const vatRatePct = (vatRow?.value as { vatRatePct?: number } | null)?.vatRatePct ?? 22;
    const nameRow = await prisma.appSetting.findUnique({ where: { key: "factory.name" } });
    const factoryName = (nameRow?.value as { name?: string })?.name ?? "Nexus Factory";

    const pdf = await renderInvoicePdf(
      {
        number: inv.number,
        dateISO: inv.createdAt.toISOString(),
        orderNumber: inv.order.number,
        partyName: inv.order.party.name,
        lines: inv.order.lines.map((l) => ({ description: l.description, qty: l.qty, netUnitCents: l.netPriceCents })),
        netCents: inv.amountCents,
        vatRatePct,
      },
      factoryName,
    );
    const dir = path.join(process.cwd(), "data", "invoices");
    fs.mkdirSync(dir, { recursive: true });
    const pdfPath = path.join(dir, `${inv.id}.pdf`);
    fs.writeFileSync(pdfPath, pdf);
    await prisma.invoice.update({ where: { id: inv.id }, data: { pdfRef: pdfPath } });
    return pdfPath;
  } catch (err) {
    console.error("[invoices] PDF render failed — will re-render on demand", invoiceId, err);
    return null;
  }
}
