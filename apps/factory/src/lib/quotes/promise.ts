/**
 * EPQ.4 — CTP-lite: the promise-date SUGGESTION formula, pure.
 *   promise = base leadTimeDays                     (production.leadTimeDays — exists since FP3)
 *           + backlog term                          (active WOs ÷ capacityPerWeek, weeks → days, ceil)
 *           + leather procurement term              (consumption-modeled lines short on leather stock)
 * Every term beyond base is config-gated (pricing.defaults capacityPerWeek /
 * procurementLeadDays — both optional): with neither configured the suggestion
 * is EXACTLY today's base-lead behavior (what quote creation already seeds).
 * The suggestion NEVER writes — the editor shows it with an Apply button and
 * the Owner stays in control.
 */

export type PromiseTermKind = "base" | "backlog" | "procurement";
export type PromiseTerm = { kind: PromiseTermKind; days: number; label: string };

/**
 * Backlog days = ceil(activeWoCount / capacityPerWeek × 7). No capacity
 * configured (or nothing in the queue) ⇒ 0 — the term stays silent.
 */
export function backlogDays(activeWoCount: number, capacityPerWeek: number | null): number {
  if (capacityPerWeek == null || capacityPerWeek <= 0 || activeWoCount <= 0) return 0;
  return Math.ceil((activeWoCount / capacityPerWeek) * 7);
}

/**
 * Leather needed by the quote's consumption-modeled lines, in m²:
 * Σ leatherSqm × (1 + wastagePct/100) × qty. Lines without a consumption row
 * contribute nothing (they are not modeled — honesty over guessing).
 */
export function requiredLeatherSqm(lines: { leatherSqm: number; wastagePct: number; qty: number }[]): number {
  return lines.reduce((s, l) => {
    if (!Number.isFinite(l.leatherSqm) || l.leatherSqm <= 0 || l.qty <= 0) return s;
    const wastage = Number.isFinite(l.wastagePct) && l.wastagePct > 0 ? l.wastagePct : 0;
    return s + l.leatherSqm * (1 + wastage / 100) * l.qty;
  }, 0);
}

export type PromiseTermsInput = {
  baseDays: number;
  activeWoCount: number;
  capacityPerWeek: number | null;
  /** true when the quote has consumption-modeled lines AND leather stock can't cover them */
  leatherShort: boolean;
  procurementLeadDays: number | null;
};

/** The full term list (zero-day terms omitted) + total. Base always present. */
export function promiseTerms(i: PromiseTermsInput): { totalDays: number; terms: PromiseTerm[] } {
  const terms: PromiseTerm[] = [{ kind: "base", days: i.baseDays, label: "base" }];
  const backlog = backlogDays(i.activeWoCount, i.capacityPerWeek);
  if (backlog > 0) terms.push({ kind: "backlog", days: backlog, label: "backlog" });
  if (i.leatherShort && i.procurementLeadDays != null && i.procurementLeadDays > 0) {
    terms.push({ kind: "procurement", days: i.procurementLeadDays, label: "leather" });
  }
  return { totalDays: terms.reduce((s, t) => s + t.days, 0), terms };
}

/** Days → compact weeks ("3w", "1.6w") or days below one week ("4d"). */
export function formatTermDays(days: number): string {
  if (days < 7) return `${days}d`;
  const weeks = Math.round((days / 7) * 10) / 10;
  return `${weeks}w`;
}

/** "3w base + 1.6w backlog + 2w leather" — the honest formula line. */
export function formulaText(terms: PromiseTerm[]): string {
  return terms.map((t) => `${formatTermDays(t.days)} ${t.label}`).join(" + ");
}
