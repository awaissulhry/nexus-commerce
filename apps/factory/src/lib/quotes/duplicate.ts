/**
 * EPQ.3 — duplicate-open-quote detection: another DRAFT/SENT quote for the
 * SAME party with the SAME template set is probably the same negotiation in
 * two records ("Q-1041 is already open for this party…" banner). Pure set
 * comparison — the route feeds it a BOUNDED candidate list (same party,
 * open states, most recent first).
 */

/** Non-null template ids as a set-equal comparison (order/duplicates ignored). */
export function sameTemplateSet(a: (string | null)[], b: (string | null)[]): boolean {
  const setA = new Set(a.filter((t): t is string => t != null));
  const setB = new Set(b.filter((t): t is string => t != null));
  if (setA.size === 0 || setA.size !== setB.size) return false; // template-less quotes never flag
  for (const t of setA) if (!setB.has(t)) return false;
  return true;
}

export type DuplicateCandidate = { id: string; number: string; templateIds: (string | null)[] };

/** First candidate whose template set matches (candidates arrive newest-first). */
export function findDuplicateOpenQuote(
  currentTemplateIds: (string | null)[],
  candidates: DuplicateCandidate[],
): { id: string; number: string } | null {
  for (const c of candidates) {
    if (sameTemplateSet(currentTemplateIds, c.templateIds)) return { id: c.id, number: c.number };
  }
  return null;
}
