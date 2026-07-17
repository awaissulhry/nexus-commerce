/**
 * FP3.3 — the CUSTOMER-FACING quote snapshot: what the PDF and the public page
 * show, and what gets frozen as a QuoteVersion. It contains prices the customer
 * pays and NOTHING ELSE — no cost, no margin, ever (constructed by hand from
 * whitelisted fields, so a schema change can't accidentally leak money).
 */
import { prisma } from "@/lib/db";
import { formatSizeRun, readSelections, type SizeRun } from "./selections";

export type SnapshotLine = { description: string; options: string[]; qty: number; unitNetCents: number; lineTotalCents: number };
export type QuoteSnapshot = {
  number: string;
  partyName: string;
  dateISO: string;
  validUntilISO: string | null;
  depositPct: number | null;
  depositCents: number;
  lines: SnapshotLine[];
  totalCents: number;
  acceptUrl: string | null;
};

/**
 * PURE — maps DB-shaped lines to customer-facing lines. It reads ONLY price
 * fields (netPriceCents); cost/margin are structurally impossible to include.
 * Unit-tested to prove no cost/margin leaks into a customer document.
 */
export function shapeSnapshotLines(
  lines: { description: string | null; templateName: string | null; selections: string[]; qty: number; netPriceCents: number; sizeRun?: SizeRun | null }[],
  labelById: Map<string, string>,
): SnapshotLine[] {
  return lines.map((l) => ({
    description: l.description ?? l.templateName ?? "Custom item",
    options: [
      ...l.selections.map((id) => labelById.get(id) ?? "").filter(Boolean),
      // EPQ.3 — a size-run line spells its matrix out for the customer ("48×5 · 50×3")
      ...(l.sizeRun ? [`Size run: ${formatSizeRun(l.sizeRun)}`] : []),
    ],
    qty: l.qty,
    unitNetCents: l.netPriceCents,
    lineTotalCents: l.netPriceCents * l.qty,
  }));
}

export async function buildQuoteSnapshot(quoteId: string, acceptUrl: string | null): Promise<QuoteSnapshot | null> {
  const quote = await prisma.quote.findUnique({
    where: { id: quoteId },
    include: {
      party: { select: { name: true } },
      lines: { orderBy: { id: "asc" }, include: { template: { select: { id: true, name: true } } } },
    },
  });
  if (!quote) return null;

  // option id → "Group: Option" labels for the referenced templates
  const templateIds = [...new Set(quote.lines.map((l) => l.templateId).filter(Boolean) as string[])];
  const groups = await prisma.optionGroup.findMany({ where: { templateId: { in: templateIds } }, include: { options: { select: { id: true, name: true } } } });
  const labelById = new Map<string, string>();
  for (const g of groups) for (const o of g.options) labelById.set(o.id, `${g.name}: ${o.name}`);

  const lines = shapeSnapshotLines(
    quote.lines.map((l) => {
      const sel = readSelections(l.selections); // EPQ.3 — legacy array OR {options,sizeRun}
      return { description: l.description, templateName: l.template?.name ?? null, selections: sel.optionIds, qty: l.qty, netPriceCents: l.netPriceCents, sizeRun: sel.sizeRun };
    }),
    labelById,
  );
  const totalCents = lines.reduce((s, l) => s + l.lineTotalCents, 0);
  const depositCents = quote.depositPct ? Math.round((totalCents * quote.depositPct) / 100) : 0;

  return {
    number: quote.number,
    partyName: quote.party.name,
    dateISO: new Date().toISOString(),
    validUntilISO: quote.validUntilAt ? quote.validUntilAt.toISOString() : null,
    depositPct: quote.depositPct,
    depositCents,
    lines,
    totalCents,
    acceptUrl,
  };
}
