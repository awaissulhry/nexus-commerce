import { describe, expect, it } from 'vitest'
import { assessRefusal, entryProblems, impactTask, namesEntry, raisedKind, reviewChangeEntry, standardLabel, transitionState } from './rules'

// Every code, name and number here is made up (the standards' codes are public).
describe('the register of laws and standards (B-W2b-249; PRD-273)', () => {
  it('matches a certificate typed "EN 17092-4:2020" to the entry code + edition, spaces and case aside', () => {
    const entry = { code: 'EN 17092-4', edition: '2020' }
    expect(standardLabel(entry.code, entry.edition)).toBe('EN 17092-4:2020')
    expect(namesEntry('EN 17092-4:2020', entry)).toBe(true)
    expect(namesEntry('  en  17092-4 : 2020 ', entry)).toBe(true)
    expect(namesEntry('EN 17092-4:2016', entry)).toBe(false)
    expect(namesEntry('EN 17092-4', entry)).toBe(false)
    expect(namesEntry('Reg. (EU) 2016/425', { code: 'Reg. (EU) 2016/425', edition: null })).toBe(true)
  })

  it('raises a change when an entry is superseded (REVISION) or withdrawn, never for other moves', () => {
    expect(raisedKind('IN_FORCE', 'SUPERSEDED')).toBe('REVISION')
    expect(raisedKind('IN_FORCE', 'WITHDRAWN')).toBe('WITHDRAWAL')
    expect(raisedKind('SUPERSEDED', 'WITHDRAWN')).toBe('WITHDRAWAL')
    expect(raisedKind('WITHDRAWN', 'IN_FORCE')).toBeNull()
    expect(raisedKind('IN_FORCE', 'IN_FORCE')).toBeNull()
  })

  it('says where a transition period stands', () => {
    expect(transitionState(null, '2026-11-10')).toBe('NONE')
    expect(transitionState('2027-06-30', '2026-11-10')).toBe('RUNNING')
    expect(transitionState('2026-12-01', '2026-11-10')).toBe('ENDS_SOON')
    expect(transitionState('2026-11-09', '2026-11-10')).toBe('ENDED')
  })

  it('refuses typed fields in words: the edition apart from the code, an https link, a successor only while superseded', () => {
    expect(entryProblems({ code: 'EN 17092-4:2020' }).map((issue) => issue.path)).toEqual(['body/code'])
    expect(entryProblems({ link: 'http://example.com' }).map((issue) => issue.path)).toEqual(['body/link'])
    expect(entryProblems({ ojDate: '2021-13-01' }).map((issue) => issue.path)).toEqual(['body/ojDate'])
    expect(entryProblems({ status: 'IN_FORCE', supersededById: '0190f0e2-7101-7000-8000-000000000001' }).map((issue) => issue.path)).toEqual(['body/supersededById'])
    expect(entryProblems({ code: 'EN 13594', edition: '2015', title: 'Gloves', titleI18n: { it: 'Guanti' }, link: 'https://example.com/en-13594' })).toEqual([])
  })
})

describe('the harmonised-standard watch (B-W2b-249; PRD-274)', () => {
  it('writes the impact task with one checklist item per affected style, due 30 days before the transition ends', () => {
    const task = impactTask(
      { standard: 'EN 17092-3:2020', kind: 'AMENDMENT', whatChanged: 'An amendment to the abrasion annex.', transitionEndsOn: '2027-06-30', styles: [{ code: 'TEST-JKT-01', name: 'Test jacket', certificate: 'TEST-CERT-1' }] },
      'en',
    )
    expect(task.title).toBe('Standard EN 17092-3:2020 amended: check the styles')
    expect(task.description).toContain('The transition period ends on 2027-06-30.')
    expect(task.checklist).toEqual(['TEST-JKT-01 Test jacket (certificate TEST-CERT-1): check against the new edition'])
    expect(task.dueDate).toBe('2027-05-31')
    const none = impactTask({ standard: 'EN 13595-1:2002', kind: 'WITHDRAWAL', whatChanged: 'Withdrawn.', transitionEndsOn: null, styles: [] }, 'it')
    expect(none).toMatchObject({ title: 'Norma EN 13595-1:2002 ritirata: controllare i modelli', checklist: [], dueDate: null })
    expect(none.description).toContain('nessun modello da controllare')
  })

  it('opens a type-change review only for REVIEW or RETEST and only for certificates the change names', () => {
    const named = ['c1', 'c2']
    expect(assessRefusal({ status: 'OPEN', impact: 'RETEST', reviewCertificateIds: ['c1'], named })).toBeNull()
    expect(assessRefusal({ status: 'OPEN', impact: 'NONE', reviewCertificateIds: [], named })).toBeNull()
    expect(assessRefusal({ status: 'OPEN', impact: 'NONE', reviewCertificateIds: ['c1'], named })?.code).toBe('NO_REVIEW_FOR_NONE')
    expect(assessRefusal({ status: 'OPEN', impact: 'REVIEW', reviewCertificateIds: ['c3'], named })?.code).toBe('NOT_NAMED')
    expect(assessRefusal({ status: 'ASSESSED', impact: 'REVIEW', reviewCertificateIds: [], named })?.code).toBe('NOT_OPEN')
  })

  it('says what a review opened by a standard change compares: the old edition and the new one (or withdrawn)', () => {
    expect(reviewChangeEntry('EN 17092-4:2020', 'REVISION', 'EN 17092-4:2026')).toEqual({ kind: 'OTHER', what: 'Standard', before: 'EN 17092-4:2020', after: 'EN 17092-4:2026', bomLineId: null })
    expect(reviewChangeEntry('EN 13595-1:2002', 'WITHDRAWAL', null).after).toBe('withdrawn')
    expect(reviewChangeEntry('EN 17092-3:2020', 'AMENDMENT', null).after).toBe('EN 17092-3:2020 (amended)')
  })
})
