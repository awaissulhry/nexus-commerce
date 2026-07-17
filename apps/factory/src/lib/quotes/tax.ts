/**
 * EPQ.5 — tax modes for quotes (Italy/EU compliance pass). PURE display
 * computation from the configured rate (financials.defaults.vatRatePct) —
 * deliberately NOT a tax engine. The mode decides how the customer documents
 * (PDF + public page) present the same net-priced quote:
 *   · IT_B2C   — GROSS-FIRST: consumer prices must headline the VAT-inclusive
 *                total (Cod. Consumo artt. 49/22 — VAT-silent consumer prices
 *                are read as VAT-inclusive AGAINST the seller). The bug fix.
 *   · IT_B2B   — net + explicit "IVA {rate}%" line + gross total.
 *   · EU_B2B   — "Non imponibile art. 41 DL 331/93", ONLY with a stored valid
 *                VIES check (substantive condition since the 2020 Quick Fixes);
 *                otherwise falls back to IT_B2B rendering (send is hard-gated).
 *   · EXTRA_EU — "Non imponibile art. 8 DPR 633/72".
 * Natura codes (N3.2 / N3.1) are stored on the quote for downstream EPF
 * invoicing — field only, nothing else consumes them here.
 */

export type TaxMode = "IT_B2C" | "IT_B2B" | "EU_B2B" | "EXTRA_EU";

export const TAX_MODES: TaxMode[] = ["IT_B2C", "IT_B2B", "EU_B2B", "EXTRA_EU"];

export const TAX_MODE_LABEL: Record<TaxMode, string> = {
  IT_B2C: "Italy · consumer (IVA inclusa)",
  IT_B2B: "Italy · business (net + IVA)",
  EU_B2B: "EU · business (art. 41, VIES)",
  EXTRA_EU: "Extra-EU (art. 8 export)",
};

/** Party-kind default: consumers buy gross, businesses net. */
export function defaultTaxModeForKind(kind: string): TaxMode {
  return kind === "CUSTOMER" ? "IT_B2C" : "IT_B2B";
}

/**
 * Resolve a stored mode (Party.taxMode or Quote.taxMode — both nullable so
 * every pre-EPQ.5 row lands on its party-kind default, the parity rule).
 */
export function resolveTaxMode(stored: string | null | undefined, partyKind: string): TaxMode {
  return stored && (TAX_MODES as string[]).includes(stored) ? (stored as TaxMode) : defaultTaxModeForKind(partyKind);
}

/** Natura code for downstream invoicing (EPF) — stored on the quote, field only. */
export function naturaForMode(mode: TaxMode): string | null {
  return mode === "EU_B2B" ? "N3.2" : mode === "EXTRA_EU" ? "N3.1" : null;
}

/**
 * A stored VIES proof is the requestIdentifier + timestamp pair; both present
 * = the art. 41 gate is open. An invalid re-check clears them (vies-check route).
 */
export function viesOk(party: { vatNumber?: string | null; viesRequestId?: string | null; viesCheckedAt?: Date | string | null }): boolean {
  return Boolean(party.vatNumber && party.viesRequestId && party.viesCheckedAt);
}

/** EU_B2B without a valid VIES check renders as IT_B2B (send is gated separately). */
export function effectiveTaxMode(mode: TaxMode, viesIsOk: boolean): { mode: TaxMode; viesFallback: boolean } {
  if (mode === "EU_B2B" && !viesIsOk) return { mode: "IT_B2B", viesFallback: true };
  return { mode, viesFallback: false };
}

export const NON_IMPONIBILE_NOTE: Partial<Record<TaxMode, string>> = {
  EU_B2B: "Operazione non imponibile IVA ai sensi dell'art. 41 D.L. 331/93",
  EXTRA_EU: "Operazione non imponibile IVA ai sensi dell'art. 8 D.P.R. 633/72",
};

/** Gross-up one net amount at the display rate (cents, nearest cent). */
export function grossCents(netCents: number, vatRatePct: number): number {
  return Math.round(netCents * (1 + vatRatePct / 100));
}

export type TaxLineInput = { unitNetCents: number; qty: number };

export type TaxBreakdown = {
  /** the EFFECTIVE mode after the VIES fallback */
  mode: TaxMode;
  vatRatePct: number;
  /** Σ net line totals — the taxable base */
  imponibileCents: number;
  /** VAT amount at the display rate (0 for non-imponibile modes) */
  ivaCents: number;
  /** what "Totale" prints: gross for IT modes, = net for non-imponibile */
  totaleCents: number;
  /** headline the gross figure (IT_B2C) */
  grossFirst: boolean;
  /** "Non imponibile …" line, when applicable */
  note: string | null;
  natura: string | null;
  /** true when EU_B2B fell back to IT_B2B for lack of a VIES proof */
  viesFallback: boolean;
  /** per-line gross unit/total (same order as input) — only present gross-first */
  unitGrossCents: number[];
  lineGrossCents: number[];
};

/**
 * The one totals computation both renderers consume. Gross-first mode rounds
 * at the UNIT (unit gross = round(unit net × (1+r))), so unit × qty = line
 * total and Σ lines = headline EXACTLY — no dangling cent anywhere a customer
 * could recompute. IVA is derived as (totale − imponibile) for the same reason.
 */
export function buildTaxBreakdown(
  lines: TaxLineInput[],
  mode: TaxMode,
  vatRatePct: number,
  viesIsOk: boolean,
): TaxBreakdown {
  const eff = effectiveTaxMode(mode, viesIsOk);
  const net = lines.reduce((s, l) => s + l.unitNetCents * l.qty, 0);

  if (eff.mode === "IT_B2C") {
    const unitGross = lines.map((l) => grossCents(l.unitNetCents, vatRatePct));
    const lineGross = lines.map((l, i) => unitGross[i] * l.qty);
    const totale = lineGross.reduce((s, c) => s + c, 0);
    return {
      mode: eff.mode, vatRatePct, imponibileCents: net, ivaCents: totale - net, totaleCents: totale,
      grossFirst: true, note: null, natura: null, viesFallback: eff.viesFallback,
      unitGrossCents: unitGross, lineGrossCents: lineGross,
    };
  }
  if (eff.mode === "IT_B2B") {
    const iva = Math.round((net * vatRatePct) / 100);
    return {
      mode: eff.mode, vatRatePct, imponibileCents: net, ivaCents: iva, totaleCents: net + iva,
      grossFirst: false, note: null, natura: null, viesFallback: eff.viesFallback,
      unitGrossCents: [], lineGrossCents: [],
    };
  }
  // non-imponibile: EU_B2B (VIES-proven) or EXTRA_EU
  return {
    mode: eff.mode, vatRatePct, imponibileCents: net, ivaCents: 0, totaleCents: net,
    grossFirst: false, note: NON_IMPONIBILE_NOTE[eff.mode] ?? null, natura: naturaForMode(eff.mode),
    viesFallback: false, unitGrossCents: [], lineGrossCents: [],
  };
}

/**
 * The base the deposit percentage applies to: what the customer actually pays.
 * B2C headlines gross, so its deposit is a share of the gross total (part of
 * the same fix); B2B stays on net — unchanged from pre-EPQ.5 behavior.
 */
export function depositBaseCents(tax: TaxBreakdown): number {
  return tax.grossFirst ? tax.totaleCents : tax.imponibileCents;
}
