/**
 * DS floor kit — the AQL sample counter's rules (gap G6, SCR-097, QHS-058): single sampling, as a final inspection
 * runs it. The app gives the plan (sample size n, and per defect class its accept number Ac); the reject number is
 * Re = Ac + 1. This module only counts and decides; it never picks a plan (ISO 2859-1 tables belong to the app).
 *
 * - **Reject at once**: as soon as any class reaches its Re the lot is rejected, even mid-sample (inspection can stop).
 * - **Accept only with the whole sample**: every piece of n inspected and every class at or under its Ac.
 * - Otherwise the inspection is open.
 * - Counts are whole, never negative; the inspected count never passes n.
 */

export interface AqlClass {
  id: string
  /** "Critici", "Maggiori", "Minori". */
  label: string
  /** Ac: the most defects of this class the sample may hold and pass. */
  accept: number
  /** Defects of this class found so far. */
  defects: number
}

export type AqlVerdict = 'open' | 'accept' | 'reject'

/** A class against its numbers: under Ac, one defect from Re (`limit`), or at Re. */
export type AqlClassState = 'ok' | 'limit' | 'reject'

export interface AqlPlan {
  sampleSize: number
  inspected: number
  classes: readonly AqlClass[]
}

/** A whole count, never negative, never past `max`. */
export function aqlCount(n: number, max?: number): number {
  const whole = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0
  return max != null && whole > max ? Math.max(0, Math.floor(max)) : whole
}

/** Re = Ac + 1 (single sampling). */
export function aqlRejectAt(cls: Pick<AqlClass, 'accept'>): number {
  return aqlCount(cls.accept) + 1
}

export function aqlClassState(cls: Pick<AqlClass, 'accept' | 'defects'>): AqlClassState {
  const defects = aqlCount(cls.defects)
  const re = aqlRejectAt(cls)
  if (defects >= re) return 'reject'
  // One more rejects — but a class with Ac 0 and nothing found is simply fine, not "at the limit".
  if (defects > 0 && defects === re - 1) return 'limit'
  return 'ok'
}

export function aqlVerdict({ sampleSize, inspected, classes }: AqlPlan): AqlVerdict {
  if (classes.some((c) => aqlClassState(c) === 'reject')) return 'reject'
  return aqlCount(inspected) >= aqlCount(sampleSize) && aqlCount(sampleSize) > 0 ? 'accept' : 'open'
}

/** Pieces of the sample still to inspect. */
export function aqlRemaining(sampleSize: number, inspected: number): number {
  return Math.max(0, aqlCount(sampleSize) - aqlCount(inspected))
}

/** How far through the sample, 0–1, for the bar. */
export function aqlProgress(sampleSize: number, inspected: number): number {
  const n = aqlCount(sampleSize)
  return n === 0 ? 0 : Math.min(1, aqlCount(inspected) / n)
}
