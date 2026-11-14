import { describe, expect, it } from 'vitest'
import { podProblems, signerOf, type PodFacts } from './rules'

/** The proof of delivery (B-W2b-398; LOG-065): only on a delivered shipment, each part once, the time between the goods leaving and now. */

const NOW = new Date('2026-11-14T09:00:00.000Z')
const facts = (over: Partial<PodFacts> = {}): PodFacts => ({ status: 'DELIVERED', shippedAt: new Date('2026-11-12T08:00:00.000Z'), kept: { signedBy: null, signedAt: null, fileId: null }, ...over })

describe('recording a proof of delivery', () => {
  it('takes who signed and when on a delivered shipment', () => {
    expect(podProblems({ signedBy: '  M. Demo ', signedAt: new Date('2026-11-13T10:00:00.000Z'), fileId: null }, facts(), NOW)).toEqual([])
    expect(signerOf('  M. Demo ')).toBe('M. Demo')
  })

  it('refuses one before delivery, a part changed once set, a time in the future or before the goods left, a two-line signer, nothing at all', () => {
    expect(podProblems({ signedBy: 'M. Demo', signedAt: null, fileId: null }, facts({ status: 'SHIPPED' }), NOW).map((issue) => issue.path)).toEqual(['refusal/NOT_DELIVERED'])
    expect(podProblems({ signedBy: 'Another', signedAt: null, fileId: null }, facts({ kept: { signedBy: 'M. Demo', signedAt: null, fileId: null } }), NOW).map((issue) => issue.path)).toEqual(['refusal/KEPT'])
    expect(podProblems({ signedBy: 'M. Demo', signedAt: null, fileId: null }, facts({ kept: { signedBy: 'M. Demo', signedAt: null, fileId: null } }), NOW)).toEqual([])
    expect(podProblems({ signedBy: null, signedAt: new Date('2026-11-15T10:00:00.000Z'), fileId: null }, facts(), NOW).map((issue) => issue.path)).toEqual(['body/signedAt'])
    expect(podProblems({ signedBy: null, signedAt: new Date('2026-11-11T10:00:00.000Z'), fileId: null }, facts(), NOW).map((issue) => issue.path)).toEqual(['body/signedAt'])
    expect(podProblems({ signedBy: 'two\nlines', signedAt: null, fileId: null }, facts(), NOW).map((issue) => issue.path)).toEqual(['body/signedBy'])
    expect(podProblems({ signedBy: null, signedAt: null, fileId: null }, facts(), NOW).map((issue) => issue.path)).toEqual(['body'])
  })
})
