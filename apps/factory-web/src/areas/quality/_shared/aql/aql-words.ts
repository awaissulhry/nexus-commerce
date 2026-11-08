import type { InspectionLevel } from '@nexus/factory-domain/quality/aql/iso2859'
import { aqlWords } from '@nexus/factory-domain/quality/aql/sampling'

/**
 * AqlSummary's words from facts (B-W2b-104; QHS-020): the derivation sentence, each class's line and the notes, as message
 * keys of the `quality-aql` catalogue with their values — never the engine's English `words`. Pure: the plan facts are
 * the API's `planView` (GET /quality/aql/calculate, …/inspections/:id) or factory-domain `samplingPlan` (the same shape).
 */

export type AqlClass = 'CRITICAL' | 'MAJOR' | 'MINOR'

export interface AqlClassFacts {
  readonly defectClass: AqlClass
  /** As Table 2-A prints it ("2.5"; "0" for critical). */
  readonly aql: string
  readonly accept: number
  readonly reject: number
  /** The class's own plan in Table 2-A after an arrow; null for AQL 0 or a lot of one. */
  readonly planLetter: string | null
  readonly planSampleSize: number | null
  readonly arrow: 'down' | 'up' | null
  readonly locked: boolean
}

export interface AqlPlanFacts {
  readonly lotSize: number
  readonly level: InspectionLevel
  /** Table 1's letter; null for a lot of one unit (inspected whole). */
  readonly codeLetter: string | null
  readonly sampleSize: number
  readonly hundredPercent: boolean
  readonly samplesDiffer: boolean
  readonly classes: readonly AqlClassFacts[]
}

export interface AqlWords {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

/** ISO 2859-1's way of writing a level: "II", "S-3". */
export const levelText = (level: InspectionLevel): string => (level.startsWith('S') ? `S-${level.slice(1)}` : level)

/** An AQL as the table prints it ("2.500" → "2.5", "0.000" → "0"). */
export const aqlShown = (value: string): string => (Number(value) === 0 ? '0' : aqlWords(value))

/** "Lot 480 · general level II → code letter H → inspect 50." (or the whole lot, or a lot of one). */
export function derivation(plan: AqlPlanFacts): AqlWords {
  if (!plan.codeLetter) return { key: 'derivation.one', params: { lot: plan.lotSize } }
  const params = { lot: plan.lotSize, level: levelText(plan.level), letter: plan.codeLetter, sample: plan.sampleSize }
  const kind = plan.level.startsWith('S') ? 'special' : 'general'
  return { key: plan.hundredPercent ? `derivation.${kind}Whole` : `derivation.${kind}`, params }
}

/** The notes under the table: the arrows Table 2-A showed, a stricter class, different samples, the whole lot. */
export function notesOf(plan: AqlPlanFacts): AqlWords[] {
  const notes: AqlWords[] = []
  for (const entry of plan.classes) {
    if (entry.locked || entry.planLetter === null) continue
    const klass = `class.${entry.defectClass}`
    if (entry.arrow && plan.codeLetter) notes.push({ key: entry.arrow === 'down' ? 'note.arrowDown' : 'note.arrowUp', params: { klass, letter: plan.codeLetter, plan: entry.planLetter, n: entry.planSampleSize ?? 0 } })
    if (entry.planSampleSize !== null && entry.planSampleSize < plan.sampleSize) notes.push({ key: 'note.stricter', params: { klass, n: entry.planSampleSize, sample: plan.sampleSize } })
  }
  if (plan.samplesDiffer) notes.push({ key: 'note.differ', params: { sample: plan.sampleSize } })
  if (plan.hundredPercent && plan.codeLetter) notes.push({ key: 'note.whole', params: { lot: plan.lotSize } })
  return notes
}

/** One class's line for a screen reader and the phone: "Major, AQL 2.5: accept up to 3, rejects at 4." */
export function classLine(entry: AqlClassFacts): AqlWords {
  return { key: entry.locked ? 'line.critical' : 'line.class', params: { klass: `class.${entry.defectClass}`, aql: aqlShown(entry.aql), accept: entry.accept, reject: entry.reject } }
}
