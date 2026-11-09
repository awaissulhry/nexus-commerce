import type { Sheet } from './plan/api'

/**
 * B-W2b-213 (FQ4:01, Inspection.inspectedCount): the bench's verdict BEFORE the decision, in words, on the summary the PIN
 * signs. The count is the inspection's own column now (no system entry), so the counter's verdict stands for every write:
 * accepted once the whole sample is counted with no class at its reject number, rejected as soon as a class reaches it
 * (or a critical check failed), else under way with what is left. Pure; the words are `floor-final-plan`'s `verdict.*`.
 */

export type VerdictTone = 'success' | 'danger' | 'neutral'

export interface VerdictLine {
  readonly key: 'verdict.accept' | 'verdict.reject' | 'verdict.rejectCheck' | 'verdict.open'
  readonly params: Readonly<Record<string, string | number>>
  readonly tone: VerdictTone
}

type Counter = Pick<Sheet['counter'], 'sampleSize' | 'inspected' | 'remaining' | 'classes' | 'verdict'>

export function verdictLine(counter: Counter): VerdictLine {
  if (counter.verdict === 'reject') {
    const over = counter.classes.find((entry) => entry.found >= entry.reject)
    // A reject with no class at its number: a failed critical check rejects the sample (the sheet's own rule).
    if (!over) return { key: 'verdict.rejectCheck', params: { inspected: counter.inspected, sample: counter.sampleSize }, tone: 'danger' }
    return { key: 'verdict.reject', params: { klass: over.defectClass, found: over.found, reject: over.reject, inspected: counter.inspected, sample: counter.sampleSize }, tone: 'danger' }
  }
  if (counter.verdict === 'accept') return { key: 'verdict.accept', params: { inspected: counter.inspected, sample: counter.sampleSize }, tone: 'success' }
  return { key: 'verdict.open', params: { inspected: counter.inspected, sample: counter.sampleSize, remaining: Math.max(0, counter.remaining) }, tone: 'neutral' }
}
