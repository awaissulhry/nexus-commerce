import { describe, expect, it } from 'vitest'
import { evaluateMaterial, type EvaluationInput } from '../substances/evaluate'
import { innocuousness, profileEditProblems, profileGaps } from './rules'

/** B-W2b-256: a material's compliance profile (pure): confirmations, EN ISO 13688 innocuousness evidence, the gaps. Made up. */

const today = '2026-11-10'
const pass = (test: string, testedOn = '2026-10-01') => ({ resultId: `r-${test}`, lotId: 'l-1', test, verdict: 'PASS' as const, testedOn })

describe('innocuousness evidence (EN ISO 13688)', () => {
  it('a leather of a PPE style needs pH, Cr VI and azo: lab results first, then the profile\'s lab reports, else missing', () => {
    const evidence = innocuousness({ kind: 'LEATHER', ppeStyles: ['JKT-01'], results: [pass('CR_VI'), { ...pass('AZO'), verdict: 'FAIL' }], files: [], today })
    expect(evidence.required).toBe(true)
    expect(evidence.parameters.map((entry) => [entry.parameter, entry.status])).toEqual([
      ['PH', 'MISSING'],
      ['CR_VI', 'MET'],
      ['AZO', 'FAILED'],
    ])
    expect(evidence.complete).toBe(false)
    const withReport = innocuousness({ kind: 'LEATHER', ppeStyles: ['JKT-01'], results: [pass('CR_VI'), pass('AZO')], files: [{ fileId: 'f-1', name: 'ph-report.pdf', category: 'TEST_REPORT', expiresOn: null }], today })
    expect(withReport.parameters[0]).toMatchObject({ parameter: 'PH', status: 'FILE', files: ['f-1'] })
    expect(withReport.complete).toBe(true)
  })

  it('an expired report or a certificate is not a lab report; a trim needs nickel; a fashion-only material needs nothing', () => {
    const expired = innocuousness({ kind: 'TEXTILE', ppeStyles: ['PNT-01'], results: [], files: [{ fileId: 'f-1', name: 'old.pdf', category: 'TEST_REPORT', expiresOn: '2026-11-09' }, { fileId: 'f-2', name: 'cert.pdf', category: 'SUPPLIER_CERTIFICATE', expiresOn: null }], today })
    expect(expired.parameters.map((entry) => entry.status)).toEqual(['MISSING', 'MISSING'])
    expect(innocuousness({ kind: 'TRIM', ppeStyles: ['JKT-01'], results: [], files: [], today }).parameters.map((entry) => entry.parameter)).toEqual(['NICKEL'])
    expect(innocuousness({ kind: 'PROTECTOR', ppeStyles: ['JKT-01'], results: [], files: [], today }).parameters).toEqual([])
    expect(innocuousness({ kind: 'LEATHER', ppeStyles: [], results: [], files: [], today }).required).toBe(false)
  })
})

describe('the gaps a profile leaves', () => {
  const none = innocuousness({ kind: 'LEATHER', ppeStyles: [], results: [], files: [], today })
  it('the composition, a leather\'s tannage and a PPE material\'s innocuousness', () => {
    expect(profileGaps({ kind: 'LEATHER', compositionConfirmed: false, tannageConfirmed: false, innocuousness: none })).toEqual(['Composition: not confirmed against the evidence yet.', "Tannage: not confirmed against the tannery's declaration yet."])
    expect(profileGaps({ kind: 'TEXTILE', compositionConfirmed: true, tannageConfirmed: false, innocuousness: innocuousness({ kind: 'TEXTILE', ppeStyles: [], results: [], files: [], today }) })).toEqual([])
    const ppe = innocuousness({ kind: 'TRIM', ppeStyles: ['JKT-01'], results: [], files: [], today })
    expect(profileGaps({ kind: 'TRIM', compositionConfirmed: true, tannageConfirmed: false, innocuousness: ppe })[0]).toBe('EN ISO 13688 innocuousness (PPE JKT-01): Nickel release: no lab result of its lots and no lab report on the profile.')
  })

  it('keeps a material that meets every rule INCOMPLETE, never BLOCKED; with no gap it is COMPLETE', () => {
    const input: EvaluationInput = {
      material: { id: 'm-1', code: 'TEX-1', name: 'Mesh', kind: 'TEXTILE', companyId: null },
      uses: [],
      markets: ['IT'],
      rules: [],
      tests: [],
      declarations: [],
      listVersions: [{ id: 'v-1', publishedOn: '2026-07-01', entryCount: 253 }],
      svhcSubstanceIds: new Set(),
      saved: { aboveThreshold: false, listVersionId: 'v-1', substanceIds: [] },
      today,
    }
    expect(evaluateMaterial(input)).toMatchObject({ state: 'COMPLETE', stateReason: null })
    expect(evaluateMaterial({ ...input, gaps: ['Composition: not confirmed against the evidence yet.'] })).toMatchObject({ state: 'INCOMPLETE', stateReason: 'Composition: not confirmed against the evidence yet.' })
  })
})

describe('a profile edit', () => {
  it('confirms a tannage only for a leather, names a country by its ISO code, says something', () => {
    expect(profileEditProblems({ compositionConfirmed: true, originCountry: 'IT' }, 'LEATHER')).toEqual([])
    expect(profileEditProblems({}, 'LEATHER').map((problem) => problem.path)).toEqual(['body'])
    expect(profileEditProblems({ tannageConfirmed: true, originCountry: 'Italy', note: ' ' }, 'TEXTILE').map((problem) => problem.path)).toEqual(['body/tannageConfirmed', 'body/originCountry', 'body/note'])
  })
})
