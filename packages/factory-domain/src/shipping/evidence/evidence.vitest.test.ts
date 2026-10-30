import { describe, expect, it } from 'vitest'
import { completeProblems, evidenceNeed, filingProblems, isEuCountry, missingWords, needChangeProblems, stateAfterFiling, stateAfterReopen, stateWhenNeeded, summary } from './evidence'

describe('intra-EU transport evidence (LOG-090; art. 41 DL 331/1993, art. 45a Reg. (EU) 282/2011)', () => {
  it('needed for a zero-rated sale to a business in another EU state, not otherwise', () => {
    expect(evidenceNeed({ taxMode: 'EU_B2B', shipToCountry: 'de', companyCountry: 'IT' }).needed).toBe(true)
    expect(evidenceNeed({ taxMode: 'EU_B2B', shipToCountry: 'IT', companyCountry: 'IT' })).toMatchObject({ needed: false, words: expect.stringMatching(/stay in IT/) })
    expect(evidenceNeed({ taxMode: 'EU_B2B', shipToCountry: 'CH', companyCountry: 'IT' })).toMatchObject({ needed: false, words: expect.stringMatching(/not to an EU state/) })
    expect(evidenceNeed({ taxMode: 'IT_B2B', shipToCountry: 'DE', companyCountry: 'IT' }).needed).toBe(false)
    expect(evidenceNeed({ taxMode: 'EU_B2C', shipToCountry: 'FR', companyCountry: 'IT' }).needed).toBe(false)
    expect(isEuCountry('GR')).toBe(true)
    expect(isEuCountry('GB')).toBe(false)
  })

  it('papers are filed once the goods left, for a shipment that needs them; the first one makes it PARTIAL', () => {
    expect(filingProblems('PACKED', 'NOT_NEEDED')[0]).toMatch(/once the goods left/)
    expect(filingProblems('SHIPPED', 'NOT_NEEDED')[0]).toMatch(/needs no intra-EU transport evidence/)
    expect(filingProblems('DELIVERED', 'AWAITED')).toEqual([])
    expect(stateAfterFiling('AWAITED')).toBe('PARTIAL')
    expect(stateAfterFiling('COMPLETE')).toBe('COMPLETE')
  })

  it('COMPLETE asks for two papers, at least one a transport document; a person checks the rest', () => {
    expect(completeProblems('AWAITED', [])[0]).toMatch(/On file: nothing\.$/)
    expect(completeProblems('PARTIAL', ['POD'])[0]).toMatch(/On file: 1 proof of delivery\.$/)
    expect(completeProblems('PARTIAL', ['OTHER', 'OTHER'])).toHaveLength(1)
    expect(completeProblems('PARTIAL', ['POD', 'CMR'])).toEqual([])
    expect(completeProblems('PARTIAL', ['CARRIER_INVOICE', 'OTHER'])).toEqual([])
    expect(completeProblems('COMPLETE', ['POD', 'CMR'])).toEqual(['The transport evidence is complete already.'])
    expect(summary(['POD', 'CMR', 'POD'])).toBe('1 signed CMR, 2 proof of delivery')
    expect(missingWords('PARTIAL', ['POD', 'CMR'])).toMatch(/a person checks them/)
    expect(missingWords('COMPLETE', ['POD', 'CMR'])).toBeNull()
  })

  it('reopen and the office saying it is (not) needed', () => {
    expect(stateAfterReopen(2)).toBe('PARTIAL')
    expect(stateAfterReopen(0)).toBe('AWAITED')
    expect(stateWhenNeeded(0)).toBe('AWAITED')
    expect(needChangeProblems('PACKED', 'NOT_NEEDED', true, 0)[0]).toMatch(/decided when the goods leave/)
    expect(needChangeProblems('SHIPPED', 'NOT_NEEDED', true, 0)).toEqual([])
    expect(needChangeProblems('SHIPPED', 'PARTIAL', false, 1)[0]).toMatch(/paper\(s\) are on file/)
    expect(needChangeProblems('SHIPPED', 'COMPLETE', false, 2)).toEqual(['The transport evidence is complete: reopen it first.'])
    expect(needChangeProblems('SHIPPED', 'AWAITED', false, 0)).toEqual([])
  })
})
