/**
 * EPQ.5 — the legal wording forks, pure. Deposit character (acconto vs
 * caparra confirmatoria — art. 1385 c.c.: the label decides both the
 * cancellation consequences AND the invoicing treatment), validity wording
 * (bare "valido fino al" = revocable offer; a firm offer needs express
 * commitment wording — art. 1329 c.c.), the B2C made-to-measure withdrawal
 * disclosure (art. 59 c.1 lett. c) D.Lgs. 206/2005 — CJEU C-529/19: the
 * exemption holds only if disclosed), and the CGV reference line.
 * One rule above all: a sum is EITHER an acconto OR a caparra — never both
 * labels on the same money.
 */

export type DepositKind = "ACCONTO" | "CAPARRA_CONFIRMATORIA";
export const DEPOSIT_KINDS: DepositKind[] = ["ACCONTO", "CAPARRA_CONFIRMATORIA"];

export const DEPOSIT_KIND_LABEL: Record<DepositKind, string> = {
  ACCONTO: "Acconto",
  CAPARRA_CONFIRMATORIA: "Caparra confirmatoria",
};

/** One-line legal hint per choice (operator-facing, editor rail). */
export const DEPOSIT_KIND_HINT: Record<DepositKind, string> = {
  ACCONTO: "Advance on the price — refundable if the deal falls through; invoiced (fattura di acconto) at receipt.",
  CAPARRA_CONFIRMATORIA: "Art. 1385 c.c. — kept if the customer walks, returned DOUBLE if the factory defaults; receipt (quietanza), VAT at delivery.",
};

export function normalizeDepositKind(stored: string | null | undefined): DepositKind {
  return stored === "CAPARRA_CONFIRMATORIA" ? "CAPARRA_CONFIRMATORIA" : "ACCONTO";
}

/** The customer-facing deposit label — exactly one legal character per sum. */
export function depositPdfLabel(kind: DepositKind, pct: number): string {
  return kind === "CAPARRA_CONFIRMATORIA"
    ? `Caparra confirmatoria (${pct}%) — art. 1385 c.c.`
    : `Acconto (${pct}%)`;
}

/**
 * B2C caparra carries the mandatory SYMMETRIC clause (research 3.3): the
 * consumer must see both directions of art. 1385, not just the one that
 * favors the seller.
 */
export const CAPARRA_B2C_SYMMETRIC_CLAUSE =
  "Caparra confirmatoria ai sensi dell'art. 1385 c.c.: in caso di recesso ingiustificato del cliente la caparra è trattenuta; in caso di inadempimento del venditore, il cliente ha diritto al doppio della caparra.";

export function depositClauseLines(kind: DepositKind, grossFirst: boolean, depositCents: number): string[] {
  if (depositCents <= 0) return [];
  if (kind === "CAPARRA_CONFIRMATORIA" && grossFirst) return [CAPARRA_B2C_SYMMETRIC_CLAUSE];
  return [];
}

export type ValidityWording = "REVOCABLE" | "IRREVOCABLE";
export const VALIDITY_WORDINGS: ValidityWording[] = ["REVOCABLE", "IRREVOCABLE"];

export const VALIDITY_WORDING_LABEL: Record<ValidityWording, string> = {
  REVOCABLE: "Revocable offer",
  IRREVOCABLE: "Firm (irrevocable) offer",
};

export function normalizeValidityWording(stored: string | null | undefined): ValidityWording {
  return stored === "IRREVOCABLE" ? "IRREVOCABLE" : "REVOCABLE";
}

/**
 * The validity sentence (research 2.2): bare "valida fino al" keeps the offer
 * revocable; the irrevocable variant is an express art. 1329 commitment.
 */
export function validityLine(wording: ValidityWording, dmyDate: string): string {
  return wording === "IRREVOCABLE"
    ? `Ci impegniamo a mantenere ferma l'offerta fino al ${dmyDate}`
    : `Offerta valida fino al ${dmyDate}`;
}

/** B2C bespoke: fixed no-withdrawal disclosure (all products are made-to-measure today). */
export const B2C_BESPOKE_CLAUSE =
  "Diritto di recesso escluso ex art. 59, c.1, lett. c) D.Lgs. 206/2005 — beni confezionati su misura.";

/** Public-page retention/privacy paragraph (research 6.3) — static, short. */
export const RETENTION_NOTICE =
  "Conserviamo i dati di accettazione (data, ora, nome confermato, indirizzo IP in forma cifrata) per 10 anni ai sensi dell'art. 2220 c.c., a fini di prova contrattuale.";

// ── CGV (condizioni generali di vendita) ─────────────────────────

export type CgvSetting = { version: string; url: string; text: string };
export const CGV_DEFAULTS: CgvSetting = { version: "1.0", url: "", text: "" };

export function withCgvDefaults(value: unknown): CgvSetting {
  const v = (value ?? {}) as Partial<CgvSetting>;
  return {
    version: typeof v.version === "string" ? v.version : CGV_DEFAULTS.version,
    url: typeof v.url === "string" ? v.url : "",
    text: typeof v.text === "string" ? v.text : "",
  };
}

/** CGV are "set" once the Owner supplied content (url or text) — empty-safe. */
export function cgvIsSet(cgv: CgvSetting): boolean {
  return Boolean(cgv.url.trim() || cgv.text.trim());
}

/** The reference line on PDF + accept page — null when unset (line omitted). */
export function cgvLine(cgv: CgvSetting): string | null {
  return cgvIsSet(cgv) ? `Condizioni generali di vendita v${cgv.version || "1.0"}` : null;
}
