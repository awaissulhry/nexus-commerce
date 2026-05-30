/**
 * PD.11 — pure development-pipeline rules, extracted so they can be
 * verified independently of Prisma. These encode the contracts the
 * fulfillment routes rely on:
 *   - eurToCents: every euro→cents parse in the development endpoints.
 *   - requiredCertsBlocking: the launch gate (PD.9/PD.10) — a project
 *     can't LAUNCH while a required certification is unapproved.
 *   - pickCheapest: the sourcing comparison (PD.6).
 */

export function eurToCents(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n * 100) : null
}

export function requiredCertsBlocking(
  certs: Array<{ required: boolean; status: string }>,
): number {
  return certs.filter((c) => c.required && c.status !== 'APPROVED').length
}

export function pickCheapest<T extends { quotedCostCents: number | null }>(
  candidates: T[],
): T | null {
  const withQuote = candidates.filter((c) => c.quotedCostCents != null)
  if (withQuote.length === 0) return null
  return withQuote.reduce((a, b) => ((b.quotedCostCents as number) < (a.quotedCostCents as number) ? b : a))
}
