import { describe, expect, it } from 'vitest'
import { basisProblems, privacyWordsProblem } from './privacy'

/** Personal-data controls on contacts (B-W2b-290; SAL-022; GDPR arts. 6, 7): the basis with its consent. */

const NOW = new Date('2026-11-12T10:00:00.000Z')

describe('lawful basis and consent', () => {
  it('records consent with when and how it was given, never in the future', () => {
    expect(basisProblems({ lawfulBasis: 'CONSENT' }, NOW).map((issue) => issue.path)).toEqual(['consentAt'])
    expect(basisProblems({ lawfulBasis: 'CONSENT', consentAt: new Date('2026-11-13T10:00:00.000Z'), consentSource: 'Signed form at the fair' }, NOW).map((issue) => issue.path)).toEqual(['consentAt'])
    expect(basisProblems({ lawfulBasis: 'CONSENT', consentAt: new Date('2026-11-01T10:00:00.000Z'), consentSource: 'Signed form at the fair' }, NOW)).toEqual([])
  })

  it('keeps when and how together for any basis', () => {
    expect(basisProblems({ lawfulBasis: 'CONTRACT', consentSource: 'A form' }, NOW).map((issue) => issue.path)).toEqual(['consentAt'])
    expect(basisProblems({ lawfulBasis: 'LEGAL_DUTY' }, NOW)).toEqual([])
    expect(basisProblems({ lawfulBasis: 'LEGITIMATE_INTEREST', consentAt: NOW, consentSource: 'x'.repeat(501) }, NOW).map((issue) => issue.path)).toEqual(['consentSource'])
  })

  it('asks words for an objection or an erasure', () => {
    expect(privacyWordsProblem('', 'what the person asked')?.message).toBe('Say what the person asked.')
    expect(privacyWordsProblem('Asked by mail on 10 Nov.', 'what the person asked')).toBeNull()
  })
})
