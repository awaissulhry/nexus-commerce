/**
 * B-W2b-213 (FQ4:01; W2b schema wave 24/33's inspectedCount on the three inspection records): the office's "38 of 50" for
 * every kind of the one Inspections list. Final: the units counted on a plan (Inspection.inspectedCount, B-W2b-97's
 * counter); incoming: the hides, rolls or (a counted lot) units inspected; in-line: the units of an in-process check's AQL
 * sample counted (InProcessCheck.sampleSize frozen at opening, inspectedCount). Words are `inspections-depth`'s `sample.*`.
 */

export interface SampleWords {
  readonly key: 'sample.nOf' | 'sample.only' | 'none'
  readonly params?: Readonly<Record<string, number>>
}

/** An in-process check's sample in words: "2 of 3" when it has an AQL sample, else nothing to count. */
export function inlineSampleOf(row: { readonly sampleSize?: number | null; readonly inspected?: number | null }): SampleWords {
  if (row.sampleSize === null || row.sampleSize === undefined) return { key: 'none' }
  return { key: 'sample.nOf', params: { done: row.inspected ?? 0, sample: row.sampleSize } }
}

/** Units counted against a sample, for a bar (0..100), null when nothing is counted against one. */
export function countPercent(done: number | null | undefined, sample: number | null | undefined): number | null {
  if (done === null || done === undefined || !sample || sample < 1) return null
  return Math.max(0, Math.min(100, Math.round((done / sample) * 100)))
}
