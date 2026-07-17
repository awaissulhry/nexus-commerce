/**
 * FP3.3 — the CUSTOMER-FACING quote snapshot: what the PDF and the public page
 * show, and what gets frozen as a QuoteVersion. It contains prices the customer
 * pays and NOTHING ELSE — no cost, no margin, ever (constructed by hand from
 * whitelisted fields, so a schema change can't accidentally leak money).
 * EPQ.5 — the snapshot gains the compliance block: per-mode tax breakdown
 * (IT_B2C gross-first — the fix; IT_B2B net+IVA; EU_B2B art. 41 gated on
 * VIES; EXTRA_EU art. 8), deposit legal character, validity wording, the
 * B2C bespoke no-withdrawal clause, and the CGV reference — all FROZEN at
 * send so the evidence bundle can point at exactly what the customer saw.
 * Legacy frozen snapshots simply lack these fields; both renderers fall back
 * to the historic net-only display for them.
 */
import { prisma } from "@/lib/db";
import { formatSizeRun, readSelections, type SizeRun } from "./selections";
import { buildTaxBreakdown, depositBaseCents, resolveTaxMode, viesOk, type TaxBreakdown, type TaxMode } from "./tax";
import {
  cgvIsSet,
  depositClauseLines,
  normalizeDepositKind,
  normalizeValidityWording,
  B2C_BESPOKE_CLAUSE,
  type CgvSetting,
  type DepositKind,
  type ValidityWording,
} from "./legal";
import { loadCgv } from "./compliance-settings";

export type SnapshotLine = {
  description: string;
  options: string[];
  qty: number;
  unitNetCents: number;
  lineTotalCents: number;
  // EPQ.5 — present only on gross-first (IT_B2C) snapshots
  unitGrossCents?: number;
  lineGrossCents?: number;
};

/** EPQ.5 — the frozen compliance block (absent on pre-EPQ.5 snapshots). */
export type SnapshotTax = {
  mode: TaxMode;
  vatRatePct: number;
  imponibileCents: number;
  ivaCents: number;
  totaleCents: number;
  grossFirst: boolean;
  note: string | null;
  natura: string | null;
};

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
  // EPQ.5 — compliance block (new snapshots always carry it)
  tax?: SnapshotTax;
  depositKind?: DepositKind;
  validityWording?: ValidityWording;
  /** pre-rendered Italian legal clauses (caparra symmetric wording, bespoke B2C) */
  clauses?: string[];
  cgv?: { version: string; url: string | null } | null;
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

/**
 * EPQ.5 — PURE assembly of the compliance block: tax breakdown, deposit on the
 * right base (gross for B2C — part of the fix), legal clauses, CGV reference.
 * Snapshot-builder outputs are unit-pinned per mode.
 */
export function shapeSnapshotCompliance(input: {
  lines: { unitNetCents: number; qty: number }[];
  mode: TaxMode;
  vatRatePct: number;
  viesIsOk: boolean;
  depositPct: number | null;
  depositKind: DepositKind;
  validityWording: ValidityWording;
  /** any quoted item is made-to-measure (template.bespoke or a template-less custom line) */
  anyBespokeLine: boolean;
  cgv: CgvSetting;
}): {
  tax: SnapshotTax;
  breakdown: TaxBreakdown;
  depositCents: number;
  depositKind: DepositKind;
  validityWording: ValidityWording;
  clauses: string[];
  cgv: { version: string; url: string | null } | null;
} {
  const breakdown = buildTaxBreakdown(input.lines, input.mode, input.vatRatePct, input.viesIsOk);
  const depositCents = input.depositPct ? Math.round((depositBaseCents(breakdown) * input.depositPct) / 100) : 0;
  const clauses: string[] = [
    ...depositClauseLines(input.depositKind, breakdown.grossFirst, depositCents),
    // the withdrawal exclusion is a CONSUMER disclosure for bespoke goods only
    ...(breakdown.grossFirst && input.anyBespokeLine && input.lines.length > 0 ? [B2C_BESPOKE_CLAUSE] : []),
  ];
  return {
    tax: {
      mode: breakdown.mode,
      vatRatePct: breakdown.vatRatePct,
      imponibileCents: breakdown.imponibileCents,
      ivaCents: breakdown.ivaCents,
      totaleCents: breakdown.totaleCents,
      grossFirst: breakdown.grossFirst,
      note: breakdown.note,
      natura: breakdown.natura,
    },
    breakdown,
    depositCents,
    depositKind: input.depositKind,
    validityWording: input.validityWording,
    clauses,
    cgv: cgvIsSet(input.cgv) ? { version: input.cgv.version || "1.0", url: input.cgv.url.trim() || null } : null,
  };
}

export async function buildQuoteSnapshot(quoteId: string, acceptUrl: string | null): Promise<QuoteSnapshot | null> {
  const quote = await prisma.quote.findUnique({
    where: { id: quoteId },
    include: {
      party: { select: { name: true, kind: true, taxMode: true, vatNumber: true, viesRequestId: true, viesCheckedAt: true } },
      lines: { orderBy: { id: "asc" }, include: { template: { select: { id: true, name: true, bespoke: true } } } },
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

  // EPQ.5 — the compliance block: quote's stored mode (party-kind default for
  // pre-EPQ.5 rows), display VAT rate from financials defaults, CGV reference.
  const finRow = await prisma.appSetting.findUnique({ where: { key: "financials.defaults" } });
  const vatRatePct = ((finRow?.value as { vatRatePct?: number })?.vatRatePct) ?? 22;
  const cgv = await loadCgv();
  const mode = resolveTaxMode(quote.taxMode ?? quote.party.taxMode, quote.party.kind);
  const compliance = shapeSnapshotCompliance({
    lines: quote.lines.map((l) => ({ unitNetCents: l.netPriceCents, qty: l.qty })),
    mode,
    vatRatePct,
    viesIsOk: viesOk(quote.party),
    depositPct: quote.depositPct,
    depositKind: normalizeDepositKind(quote.depositKind),
    validityWording: normalizeValidityWording(quote.validityWording),
    anyBespokeLine: quote.lines.some((l) => (l.template ? l.template.bespoke : true)),
    cgv,
  });
  // gross-first: stamp the per-line gross figures the customer documents print
  if (compliance.breakdown.grossFirst) {
    lines.forEach((l, i) => {
      l.unitGrossCents = compliance.breakdown.unitGrossCents[i];
      l.lineGrossCents = compliance.breakdown.lineGrossCents[i];
    });
  }

  return {
    number: quote.number,
    partyName: quote.party.name,
    dateISO: new Date().toISOString(),
    validUntilISO: quote.validUntilAt ? quote.validUntilAt.toISOString() : null,
    depositPct: quote.depositPct,
    depositCents: compliance.depositCents,
    lines,
    totalCents,
    acceptUrl,
    tax: compliance.tax,
    depositKind: compliance.depositKind,
    validityWording: compliance.validityWording,
    clauses: compliance.clauses,
    cgv: compliance.cgv,
  };
}
