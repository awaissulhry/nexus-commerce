import { describe, expect, it } from 'vitest'

import { aqlClassState, aqlCount, aqlProgress, aqlRejectAt, aqlRemaining, aqlVerdict, type AqlClass } from './aqlModel'

// A made-up single-sampling plan: n 50; critical Ac 0, major Ac 3, minor Ac 5.
const plan = (major: number, minor = 0, critical = 0): AqlClass[] => [
  { id: 'critical', label: 'Critici', accept: 0, defects: critical },
  { id: 'major', label: 'Maggiori', accept: 3, defects: major },
  { id: 'minor', label: 'Minori', accept: 5, defects: minor },
]

describe('AQL sample counter (G6)', () => {
  it('reject number is Ac + 1', () => {
    expect(aqlRejectAt({ accept: 0 })).toBe(1)
    expect(aqlRejectAt({ accept: 3 })).toBe(4)
  })

  it('a class: ok under its limit, at the limit one defect before Re, rejected at Re', () => {
    expect(aqlClassState({ accept: 3, defects: 2 })).toBe('ok')
    expect(aqlClassState({ accept: 3, defects: 3 })).toBe('limit')
    expect(aqlClassState({ accept: 3, defects: 4 })).toBe('reject')
    // Ac 0 with nothing found is fine, not "at the limit".
    expect(aqlClassState({ accept: 0, defects: 0 })).toBe('ok')
    expect(aqlClassState({ accept: 0, defects: 1 })).toBe('reject')
  })

  it('rejects at once, mid-sample, when any class reaches its Re', () => {
    expect(aqlVerdict({ sampleSize: 50, inspected: 12, classes: plan(4) })).toBe('reject')
    expect(aqlVerdict({ sampleSize: 50, inspected: 3, classes: plan(0, 0, 1) })).toBe('reject')
  })

  it('accepts only with the whole sample inspected and every class within Ac', () => {
    expect(aqlVerdict({ sampleSize: 50, inspected: 49, classes: plan(3, 5) })).toBe('open')
    expect(aqlVerdict({ sampleSize: 50, inspected: 50, classes: plan(3, 5) })).toBe('accept')
    expect(aqlVerdict({ sampleSize: 0, inspected: 0, classes: plan(0) })).toBe('open')
  })

  it('counts are whole, never negative, the inspected count never past n', () => {
    expect(aqlCount(-2)).toBe(0)
    expect(aqlCount(3.7)).toBe(3)
    expect(aqlCount(55, 50)).toBe(50)
    expect(aqlCount(Number.NaN)).toBe(0)
    expect(aqlRemaining(50, 23)).toBe(27)
    expect(aqlRemaining(50, 60)).toBe(0)
    expect(aqlProgress(50, 25)).toBe(0.5)
    expect(aqlProgress(0, 5)).toBe(0)
  })
})
