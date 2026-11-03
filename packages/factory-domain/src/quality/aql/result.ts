import type { AqlDefectClass } from './sampling'

/**
 * The automatic result and scoring (B-W2b-93; QHS-013): what the sample says as it is counted, in the same model as the
 * design system's AqlCounter (packages/ui floor aqlModel.ts) so the office's AqlSummary, the calculator and the bench's
 * counter never disagree:
 *
 * - a class **rejects at once** when its found count reaches Re (= Ac + 1), even mid-sample (inspection may stop: the
 *   stop-at-reject setting decides, B-W2b-79's QualitySettings);
 * - the lot is **accepted only with the whole sample** inspected and every class at or under its Ac;
 * - otherwise it is **open**. A class is `ok`, at its `limit` (one more rejects: Ac found, Ac > 0 or a defect found), or
 *   `reject`.
 *
 * The result a signature would carry (`resultNow`) follows the database's rule (W1's "Inspection_guard" writes
 * `computedResult`; the trigger stays the last word): any critical defect, a class over its Ac, a checklist item not ok,
 * or (on a plan) a failed critical check → FAIL; else PASS. On a plan, a PASS also needs every mandatory check answered
 * (B-W2b-76's "Inspection_plan_guard"). A decision against it is an override with the inspector's written reason; a PASS
 * over a FAIL only when the acceptance numbers alone made it fail (W1 decisionProblems; Owner answer Q1 (a): its release
 * needs a second person).
 */

export type AqlVerdict = 'open' | 'accept' | 'reject'
export type AqlClassState = 'ok' | 'limit' | 'reject'

const whole = (n: number | null | undefined, max?: number): number => {
  const value = typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0
  return max !== undefined && value > max ? Math.max(0, Math.floor(max)) : value
}

/** Re = Ac + 1 (single sampling). */
export const rejectAt = (accept: number): number => whole(accept) + 1

/** A class against its numbers (aqlModel aqlClassState). */
export function classState(accept: number, found: number): AqlClassState {
  const count = whole(found)
  const re = rejectAt(accept)
  if (count >= re) return 'reject'
  // One more rejects — but a class with Ac 0 and nothing found is simply fine, not "at the limit".
  if (count > 0 && count === re - 1) return 'limit'
  return 'ok'
}

/** The sample's verdict as it stands (aqlModel aqlVerdict); an unknown inspected count is never a whole sample. */
export function aqlVerdict(input: { readonly sampleSize: number; readonly inspected: number | null; readonly classes: readonly { readonly accept: number; readonly found: number }[] }): AqlVerdict {
  if (input.classes.some((entry) => classState(entry.accept, entry.found) === 'reject')) return 'reject'
  if (input.inspected === null) return 'open'
  return whole(input.inspected) >= whole(input.sampleSize) && whole(input.sampleSize) > 0 ? 'accept' : 'open'
}

const CLASS_NAME: Readonly<Record<AqlDefectClass, string>> = Object.freeze({ CRITICAL: 'Critical', MAJOR: 'Major', MINOR: 'Minor' })
const units = (n: number): string => `${n} ${n === 1 ? 'unit' : 'units'}`

/** The live words of one class ("Major: 3 found, accept up to 3 - passes. One more rejects the lot."). */
export function classWords(defectClass: AqlDefectClass, accept: number, found: number): string {
  const name = CLASS_NAME[defectClass]
  const count = whole(found)
  const state = classState(accept, count)
  if (defectClass === 'CRITICAL') return count === 0 ? 'Critical: none found - a critical defect is never accepted.' : `Critical: ${count} found - a critical defect is never accepted: the lot is rejected.`
  const head = `${name}: ${count} found, accept up to ${whole(accept)}`
  if (state === 'reject') return `${head} - rejects the lot.`
  if (state === 'limit') return `${head} - passes. One more rejects the lot.`
  return `${head} - passes.`
}

/** What the checks of a plan say (B-W2b-76 results), or W1's checklist: names in words. */
export interface ChecksNow {
  /** Checks answered "not ok" (W1 checklist items, plan checks that failed). */
  readonly failed: readonly string[]
  /** Plan checks of class CRITICAL that failed (a subset of `failed`). */
  readonly failedCritical: readonly string[]
  /** Mandatory plan checks with no result yet. */
  readonly mandatoryMissing: readonly string[]
}

export const NO_CHECKS: ChecksNow = Object.freeze({ failed: [], failedCritical: [], mandatoryMissing: [] })

export interface ResultAsk {
  readonly sampleSize: number
  /** Units of the sample inspected so far; null: not counted (W1 keeps no count). */
  readonly inspected: number | null
  /** Per class its AQL as printed, Ac, and the units with a defect of the class found. */
  readonly classes: readonly { readonly defectClass: AqlDefectClass; readonly aql: string; readonly accept: number; readonly found: number }[]
  readonly checks?: ChecksNow | undefined
}

export interface ClassResult {
  readonly defectClass: AqlDefectClass
  readonly aql: string
  readonly accept: number
  readonly reject: number
  readonly found: number
  readonly state: AqlClassState
  /** How many more of this class the sample may hold and still pass (0 at the limit; null once it rejects). */
  readonly spare: number | null
  readonly words: string
}

export interface AqlResult {
  readonly verdict: AqlVerdict
  readonly classes: readonly ClassResult[]
  /** "38 of 50 inspected"; null while nothing counts the units. */
  readonly progress: { readonly inspected: number; readonly sampleSize: number; readonly remaining: number; readonly words: string } | null
  /** What a signature now would carry, as the database computes it. */
  readonly resultNow: 'PASS' | 'FAIL'
  /** Why it is FAIL (empty for PASS), in words; `byCountsOnly`: only the acceptance numbers. */
  readonly reasons: readonly string[]
  readonly byCountsOnly: boolean
  /** What keeps a PASS from being signed yet (mandatory checks with no result). */
  readonly blockers: readonly string[]
  /** The override rule for this state, in words (QHS-013). */
  readonly overrideWords: string
  /** The whole state in one sentence. */
  readonly words: string
}

/** The automatic result of a sample as it stands (QHS-013). */
export function aqlResult(ask: ResultAsk): AqlResult {
  const checks = ask.checks ?? NO_CHECKS
  const classes: ClassResult[] = ask.classes.map((entry) => {
    const found = whole(entry.found)
    const state = classState(entry.accept, found)
    return { defectClass: entry.defectClass, aql: entry.aql, accept: whole(entry.accept), reject: rejectAt(entry.accept), found, state, spare: state === 'reject' ? null : whole(entry.accept) - found, words: classWords(entry.defectClass, entry.accept, found) }
  })
  const verdict = aqlVerdict({ sampleSize: ask.sampleSize, inspected: ask.inspected, classes })
  const hard: string[] = []
  const soft: string[] = []
  const critical = classes.find((entry) => entry.defectClass === 'CRITICAL')
  if (critical && critical.found > 0) hard.push(`${units(critical.found)} with a critical defect: a critical defect is never accepted.`)
  if (checks.failedCritical.length > 0) hard.push(`Critical checks failed: ${checks.failedCritical.join(', ')}.`)
  const otherFailed = checks.failed.filter((name) => !checks.failedCritical.includes(name))
  if (otherFailed.length > 0) hard.push(`Checks not ok: ${otherFailed.join(', ')}.`)
  for (const entry of classes) if (entry.defectClass !== 'CRITICAL' && entry.state === 'reject') soft.push(`${units(entry.found)} with a ${entry.defectClass.toLowerCase()} defect; the plan accepts ${entry.accept}.`)
  const reasons = [...hard, ...soft]
  const resultNow = reasons.length === 0 ? 'PASS' : 'FAIL'
  const byCountsOnly = hard.length === 0 && soft.length > 0
  const blockers = checks.mandatoryMissing.length > 0 ? [`Mandatory checks without a result: ${checks.mandatoryMissing.join(', ')}.`] : []
  const overrideWords =
    resultNow === 'PASS'
      ? 'The rules say PASS: signing FAIL over it is an override with your written reason (QHS-013).'
      : byCountsOnly
        ? 'The rules say FAIL on the acceptance numbers alone: a PASS over it is an override with your written reason, and its release needs a second person.'
        : `A PASS over this FAIL is never signed: ${hard.join(' ')}`
  const inspected = ask.inspected === null ? null : whole(ask.inspected, ask.sampleSize)
  const progress = inspected === null ? null : { inspected, sampleSize: whole(ask.sampleSize), remaining: Math.max(0, whole(ask.sampleSize) - inspected), words: `${inspected} of ${whole(ask.sampleSize)} inspected` }
  const head = verdict === 'reject' ? 'The lot is rejected' : verdict === 'accept' ? 'The whole sample is inspected and every class is within its acceptance number: the lot is accepted' : 'Open'
  const words = [`${head}${progress ? ` (${progress.words})` : ''}.`, ...classes.map((entry) => entry.words), ...blockers].join(' ')
  return { verdict, classes, progress, resultNow, reasons, byCountsOnly, blockers, overrideWords, words }
}
