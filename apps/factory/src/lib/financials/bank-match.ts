/**
 * FP9.3 — match bank-statement rows to orders (pure, tested). Two signals, in
 * order: an explicit ORD-n / INV-n reference in the description (high), then an
 * exact amount against a single open balance (medium). Anything ambiguous or
 * unmatched is left for the Owner — the import never auto-applies a guess. This
 * is matching-to-orders, NOT bank reconciliation.
 */

export type BankRow = { date: string; amountCents: number; description: string };
export type MatchTarget = { orderId: string; number: string; partyName: string; balanceCents: number; invoiceNumbers: string[] };
export type Confidence = "high" | "medium" | "none";
export type BankMatch = {
  row: BankRow;
  orderId: string | null;
  number: string | null;
  partyName: string | null;
  amountCents: number;
  confidence: Confidence;
  reason: string;
  /** EPF1 (D-10) — the reference matched but the order's balance is already ≤ 0 (rule-1 balance blindness). */
  zeroBalance?: boolean;
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The number appears as a whole token in the text (so ORD-1 doesn't match ORD-12). */
const tokenMatch = (text: string, token: string) => new RegExp(`(?:^|[^0-9A-Za-z])${escapeRe(token)}(?![0-9A-Za-z])`, "i").test(text);

export function matchBankRow(row: BankRow, targets: MatchTarget[]): BankMatch {
  const none = (reason: string): BankMatch => ({ row, orderId: null, number: null, partyName: null, amountCents: row.amountCents, confidence: "none", reason });
  const hit = (t: MatchTarget, confidence: Confidence, reason: string): BankMatch => ({ row, orderId: t.orderId, number: t.number, partyName: t.partyName, amountCents: row.amountCents, confidence, reason });

  // 1. an order/invoice number appears as a whole token in the description (any numbering scheme)
  for (const t of targets) {
    const matched = [t.number, ...t.invoiceNumbers].find((n) => tokenMatch(row.description, n));
    if (matched) {
      // EPF1 (D-10): a reference to an already-settled order is flagged, not
      // silently re-proposed — the Owner sees it before it double-pays.
      if (t.balanceCents <= 0) return { ...hit(t, "high", `reference ${matched} in the description — but ${t.number} has no open balance`), zeroBalance: true };
      return hit(t, "high", `reference ${matched} in the description`);
    }
  }

  // 2. exact amount to a single open balance
  if (row.amountCents > 0) {
    const exact = targets.filter((x) => x.balanceCents === row.amountCents && x.balanceCents > 0);
    if (exact.length === 1) return hit(exact[0], "medium", `amount matches ${exact[0].number}'s open balance`);
    if (exact.length > 1) return none("amount matches more than one open balance");
  }
  return none("no match — assign it by hand");
}

export function matchBankRows(rows: BankRow[], targets: MatchTarget[]): BankMatch[] {
  return rows.map((r) => matchBankRow(r, targets));
}

/**
 * Parse a simple bank CSV: a header naming `date`, `amount`, `description`
 * columns (any order), amount in EUR (comma or dot decimal, optional € / sign).
 * Real per-bank format adapters are a follow-up; this is the neutral shape.
 */
export function parseBankCsv(text: string): BankRow[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const header = splitCsv(lines[0]).map((h) => h.trim().toLowerCase());
  const di = header.findIndex((h) => h.includes("date"));
  const ai = header.findIndex((h) => h.includes("amount") || h.includes("importo"));
  const si = header.findIndex((h) => h.includes("desc") || h.includes("causale") || h.includes("reference"));
  const rows: BankRow[] = [];
  for (const line of lines.slice(1)) {
    const cols = splitCsv(line);
    const amountCents = toCents(cols[ai] ?? "");
    if (!Number.isFinite(amountCents) || amountCents === 0) continue;
    rows.push({ date: (cols[di] ?? "").trim(), amountCents, description: (cols[si] ?? "").trim() });
  }
  return rows;
}

function splitCsv(line: string): string[] {
  // minimal CSV: quoted fields with commas, no embedded quotes-in-quotes
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (const ch of line) {
    if (ch === '"') inQ = !inQ;
    else if (ch === "," && !inQ) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function toCents(raw: string): number {
  const s = raw.replace(/[€\s]/g, "").replace(/\.(?=\d{3}\b)/g, "").replace(",", ".");
  const n = parseFloat(s);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

/**
 * EPF1 (D-10) — the statement row's own date becomes Payment.receivedAt (it
 * used to be discarded). Accepts ISO `YYYY-MM-DD` and Italian `dd/mm/yyyy`
 * (also `-` / `.` separators). Returns a UTC-midnight Date — for a +1/+2 zone
 * that instant still falls on the same Rome calendar day. Null = unparseable
 * (the caller falls back to "now" and says so in the row note).
 */
export function parseBankDate(raw: string): Date | null {
  const s = raw.trim();
  let y = 0, mo = 0, d = 0;
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/.exec(s);
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else {
    m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/.exec(s);
    if (m) { y = +m[3]; mo = +m[2]; d = +m[1]; }
    else return null;
  }
  const date = new Date(Date.UTC(y, mo - 1, d));
  // reject rollovers like 31/02 (Date silently wraps them into March)
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date;
}
