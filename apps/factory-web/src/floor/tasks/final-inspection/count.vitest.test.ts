import { describe, expect, it } from 'vitest'
import { verdictLine } from './count'

const klass = (defectClass: 'CRITICAL' | 'MAJOR' | 'MINOR', accept: number, found: number) => ({ defectClass, aql: '2.5', accept, reject: accept + 1, found, state: 'ok' as const, spare: null, words: '' })

/** B-W2b-213: the bench's verdict before the decision (the count is Inspection.inspectedCount). */
describe('the verdict before the decision', () => {
  it('under way, accepted with the whole sample, rejected by a class or a critical check', () => {
    const base = { sampleSize: 50, classes: [klass('CRITICAL', 0, 0), klass('MAJOR', 1, 1), klass('MINOR', 3, 0)] }
    expect(verdictLine({ ...base, inspected: 38, remaining: 12, verdict: 'open' })).toEqual({ key: 'verdict.open', params: { inspected: 38, sample: 50, remaining: 12 }, tone: 'neutral' })
    expect(verdictLine({ ...base, inspected: 50, remaining: 0, verdict: 'accept' })).toEqual({ key: 'verdict.accept', params: { inspected: 50, sample: 50 }, tone: 'success' })
    expect(verdictLine({ ...base, classes: [klass('CRITICAL', 0, 0), klass('MAJOR', 1, 2), klass('MINOR', 3, 0)], inspected: 20, remaining: 30, verdict: 'reject' })).toMatchObject({ key: 'verdict.reject', params: { klass: 'MAJOR', found: 2, reject: 2 }, tone: 'danger' })
    expect(verdictLine({ ...base, inspected: 20, remaining: 30, verdict: 'reject' })).toMatchObject({ key: 'verdict.rejectCheck', tone: 'danger' })
  })
})
