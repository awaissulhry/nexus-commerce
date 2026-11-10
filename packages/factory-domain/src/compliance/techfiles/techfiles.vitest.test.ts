import { describe, expect, it } from 'vitest'
import { packPaper, type PackPaperInput } from './paper'
import {
  addDays,
  addMonths,
  ANNEX_III_POINTS,
  annexSummary,
  batchEvidence,
  completeProblems,
  evidenceProblems,
  manifestText,
  nextDueOn,
  packRequestProblems,
  retainUntilOf,
  retentionState,
  riskRowProblems,
  signProblems,
  testPlan,
  testPlanProblems,
  testRecordProblems,
  zipSafeName,
  type ItemFacts,
  type TestFacts,
} from './rules'

const allReviewed: ItemFacts[] = ANNEX_III_POINTS.map((point) => ({ point, state: point.startsWith('L_') || point.startsWith('M_') ? 'NOT_APPLICABLE' : 'REVIEWED' }))

describe('the Annex III checklist (PRD-296)', () => {
  it('reads each point from its items and counts the done ones', () => {
    const items: ItemFacts[] = [
      { point: 'A_DESCRIPTION', state: 'REVIEWED' },
      { point: 'B_RISK_ASSESSMENT', state: 'LINKED' },
      { point: 'D_DRAWINGS', state: 'REVIEWED' },
      { point: 'D_DRAWINGS', state: 'MISSING' },
      { point: 'L_SINGLE_UNIT', state: 'NOT_APPLICABLE' },
    ]
    const summary = annexSummary(items)
    expect(summary.outOf).toBe(13)
    expect(summary.done).toBe(2)
    expect(summary.open).toBe('B_RISK_ASSESSMENT')
    expect(summary.points.find((entry) => entry.point === 'D_DRAWINGS')).toMatchObject({ letter: 'd', state: 'MISSING', items: 2 })
    expect(summary.points.find((entry) => entry.point === 'C_REQUIREMENTS')!.state).toBe('NONE')
    // one item missing, nine points without any
    expect(summary.missingItems).toBe(1 + 9)
  })

  it('completes only with every point reviewed or not applicable, and a category II or III style with its certificate', () => {
    expect(completeProblems({ status: 'OPEN', items: allReviewed, ppeCategory: 'CATEGORY_II', certificateId: 'c' })).toEqual([])
    expect(completeProblems({ status: 'OPEN', items: allReviewed, ppeCategory: 'CATEGORY_I', certificateId: null })).toEqual([])
    expect(completeProblems({ status: 'OPEN', items: allReviewed, ppeCategory: 'CATEGORY_III', certificateId: null }).map((issue) => issue.path)).toEqual(['certificateId'])
    const linked = allReviewed.map((item) => (item.point === 'H_CALCULATIONS' ? { ...item, state: 'LINKED' as const } : item)).filter((item) => item.point !== 'K_USER_INFORMATION')
    const problems = completeProblems({ status: 'OPEN', items: linked, ppeCategory: 'CATEGORY_II', certificateId: 'c' })
    expect(problems.map((issue) => issue.path)).toEqual(['points/H_CALCULATIONS', 'points/K_USER_INFORMATION'])
    expect(problems[0]!.message).toContain('not reviewed')
    expect(completeProblems({ status: 'COMPLETE', items: allReviewed, ppeCategory: 'CATEGORY_II', certificateId: 'c' })[0]!.message).toContain('complete already')
  })

  it('links one evidence record of a known kind, or one file', () => {
    expect(evidenceProblems({ recordType: 'Certificate', recordId: 'x' })).toEqual([])
    expect(evidenceProblems({ fileId: 'f' })).toEqual([])
    expect(evidenceProblems({})).toEqual([])
    expect(evidenceProblems({ recordType: 'Certificate' })[0]!.path).toBe('body/recordId')
    expect(evidenceProblems({ recordType: 'Certificate', recordId: 'x', fileId: 'f' })[0]!.path).toBe('body/fileId')
    expect(evidenceProblems({ recordType: 'Invoice', recordId: 'x' })[0]!.message).toContain('is not evidence')
  })
})

describe('the product risk assessment (PRD-301)', () => {
  const row = { hazard: 'ABRASION', intendedUse: 'Road riding', control: 'Cowhide 1.2 mm, double stitched', residualRisk: 'LOW', garmentZone: 'shoulder' }
  it('checks a hazard row as the database will', () => {
    expect(riskRowProblems(row)).toEqual([])
    expect(riskRowProblems({ ...row, hazard: 'OTHER' }).map((issue) => issue.path)).toEqual(['body/hazardNote'])
    expect(riskRowProblems({ ...row, garmentZone: 'Left Knee' }).map((issue) => issue.path)).toEqual(['body/garmentZone'])
    expect(riskRowProblems({ ...row, control: ' ', residualRisk: 'SOME' }).map((issue) => issue.path)).toEqual(['body/control', 'body/residualRisk'])
  })
  it('signs a draft with at least one hazard, a typed name and function', () => {
    expect(signProblems({ status: 'DRAFT', rows: 2, name: 'Made-up Quality', function: 'Quality manager' })).toEqual([])
    expect(signProblems({ status: 'SIGNED', rows: 0, name: '', function: '' }).map((issue) => issue.path)).toEqual(['status', 'rows', 'body/name', 'body/function'])
  })
})

describe('days and keeping (QHS-110)', () => {
  it('counts months and ten years as PostgreSQL does', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28')
    expect(addMonths('2026-11-10', 3)).toBe('2027-02-10')
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15')
    expect(retainUntilOf('2024-02-29')).toBe('2034-02-28')
    expect(retainUntilOf('2026-11-10')).toBe('2036-11-10')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
  })
  it('says where a record\'s keeping stands', () => {
    expect(retentionState(null, '2026-11-10')).toBe('NOT_SET')
    expect(retentionState('2036-11-10', '2026-11-10')).toBe('KEPT')
    expect(retentionState('2027-06-01', '2026-11-10')).toBe('ENDS_WITHIN_YEAR')
    expect(retentionState('2026-11-09', '2026-11-10')).toBe('MAY_GO')
  })
})

describe('production-control tests (QHS-048)', () => {
  const base = { testName: null, workOrderId: null, batchNumber: null } as const
  it('dues the next test by its frequency', () => {
    expect(nextDueOn('2026-11-10', 'MONTHLY')).toBe('2026-12-10')
    expect(nextDueOn('2026-11-10', 'QUARTERLY')).toBe('2027-02-10')
    expect(nextDueOn('2026-11-10', 'YEARLY')).toBe('2027-11-10')
    expect(nextDueOn('2026-11-10', 'EVERY_BATCH')).toBeNull()
    expect(nextDueOn('2026-11-10', 'ONCE')).toBeNull()
  })
  it('plans each kind: the planned test first, else after the last one; overdue and due soon first', () => {
    const tests: TestFacts[] = [
      { ...base, id: '1', test: 'SEAM_STRENGTH', frequency: 'YEARLY', dueOn: '2025-10-01', result: 'PASS', testedOn: '2025-10-01' },
      { ...base, id: '2', test: 'POCKET_RETENTION', frequency: 'QUARTERLY', dueOn: '2026-11-20', result: null, testedOn: null },
      { ...base, id: '3', test: 'LABEL_DURABILITY', frequency: 'EVERY_BATCH', dueOn: '2026-11-01', result: 'FAIL', testedOn: '2026-11-02' },
      { ...base, id: '4', test: 'OTHER', testName: 'Zip pull', frequency: 'ONCE', dueOn: '2026-10-01', result: 'PASS', testedOn: '2026-10-02' },
    ]
    const plan = testPlan(tests, '2026-11-10')
    expect(plan.map((entry) => [entry.test, entry.state, entry.nextDueOn])).toEqual([
      ['SEAM_STRENGTH', 'OVERDUE', '2026-10-01'],
      ['POCKET_RETENTION', 'DUE_SOON', '2026-11-20'],
      ['LABEL_DURABILITY', 'EVERY_BATCH', null],
      ['OTHER', 'DONE', null],
    ])
    expect(plan[1]).toMatchObject({ dueTestId: '2', lastTestedOn: null })
    expect(plan[2]).toMatchObject({ lastResult: 'FAIL', lastTestedOn: '2026-11-02' })
  })
  it('checks a plan and a result', () => {
    expect(testPlanProblems({ test: 'SEAM_STRENGTH', frequency: 'YEARLY', dueOn: '2026-12-01' })).toEqual([])
    expect(testPlanProblems({ test: 'OTHER', frequency: 'DAILY', dueOn: '1/12/2026', workOrderId: 'w', batchNumber: 'B' }).map((issue) => issue.path)).toEqual(['body/testName', 'body/frequency', 'body/dueOn', 'body/batchNumber'])
    expect(testRecordProblems({ result: 'PASS', testedOn: '2026-11-10', testedBy: 'Made-up Lab' }, '2026-11-10')).toEqual([])
    expect(testRecordProblems({ result: 'FAIL', testedOn: '2026-11-11', testedBy: '' }, '2026-11-10').map((issue) => issue.path)).toEqual(['body/testedOn', 'body/testedBy', 'body/resultNote'])
  })
})

describe('conformity to type per batch (PRD-302)', () => {
  const facts = { done: true, finalStatus: 'PASSED', passedInspections: 1, releases: 2, required: [{ test: 'POCKET_RETENTION' as const, testName: null }], recorded: [{ test: 'POCKET_RETENTION' as const, testName: null, result: 'PASS' as const }] }
  it('is complete with a passed final inspection, released garments and every every-batch test', () => {
    expect(batchEvidence(facts)).toEqual({ state: 'COMPLETE', missing: [], failed: [] })
  })
  it('says what is missing, and whether the work is still running', () => {
    const missing = batchEvidence({ ...facts, recorded: [], releases: 0 })
    expect(missing.state).toBe('MISSING')
    expect(missing.missing.map((entry) => entry.code)).toEqual(['RELEASE', 'TEST'])
    expect(batchEvidence({ ...facts, done: false, passedInspections: 0, finalStatus: null, releases: 0, recorded: [] }).state).toBe('IN_PROGRESS')
  })
  it('fails on the newest failed test or a failed final inspection', () => {
    expect(batchEvidence({ ...facts, recorded: [{ test: 'POCKET_RETENTION', testName: null, result: 'FAIL' }, { test: 'POCKET_RETENTION', testName: null, result: 'PASS' }] }).failed).toEqual(['The pocket retention test failed.'])
    expect(batchEvidence({ ...facts, recorded: [{ test: 'POCKET_RETENTION', testName: null, result: 'PASS' }, { test: 'POCKET_RETENTION', testName: null, result: 'FAIL' }] }).state).toBe('COMPLETE')
    expect(batchEvidence({ ...facts, finalStatus: 'FAILED', passedInspections: 0 }).state).toBe('FAILED')
  })
})

describe('evidence packs (PRD-299)', () => {
  const request = { purpose: 'AUTHORITY', language: 'de', recipient: 'Made-up surveillance authority', scope: { kind: 'STYLE' as const }, include: ['DOC', 'CERTIFICATES'] }
  it('checks what is asked', () => {
    expect(packRequestProblems(request)).toEqual([])
    expect(packRequestProblems({ ...request, purpose: 'SHIPMENT', language: 'deu-DE', recipient: '', include: ['DOC', 'DOC', 'PRICES'] }).map((issue) => issue.path)).toEqual(['body/purpose', 'body/language', 'body/recipient', 'body/include/1', 'body/include/2'])
    expect(packRequestProblems({ ...request, scope: { kind: 'SERIALS', serialFrom: 'SN-9', serialTo: 'SN-1' } }).map((issue) => issue.path)).toEqual(['body/scope/serialTo'])
    expect(packRequestProblems({ ...request, scope: { kind: 'BATCHES', batchNumbers: [] } }).map((issue) => issue.path)).toEqual(['body/scope/batchNumbers'])
  })
  it('writes the manifest the fingerprint is taken of, and safe names', () => {
    expect(manifestText('EP-2026-0001', [{ title: 'DoC it r1', sha256: 'a'.repeat(64) }])).toBe(`Nexus Factory evidence pack EP-2026-0001\n${'a'.repeat(64)}  DoC it r1\n`)
    expect(zipSafeName('dir/../DoC: "it".pdf')).toBe('dir_.._DoC_ _it_.pdf')
    expect(zipSafeName('..')).toBe('document')
  })
  it('prints the cover, the contents and the chosen sections, in Italian for Italian and English otherwise', () => {
    const input: PackPaperInput = {
      language: 'de',
      number: 'EP-2026-0001',
      purpose: 'AUTHORITY',
      recipient: 'Made-up authority',
      builtAt: '2026-11-10T09:00:00.000Z',
      builtAtWords: '2026-11-10 10:00',
      company: { name: 'Made-up S.r.l.', lines: [], legal: '' },
      technicalFile: { number: 'TF-0001', styleCode: 'JKT-01', styleName: 'Made-up jacket', certificate: 'CERT-1' },
      scopeWords: 'The whole style',
      fingerprint: 'b'.repeat(64),
      include: ['TECHFILE_INDEX', 'RISK_ASSESSMENT', 'DOC'],
      contents: [{ title: 'DoC', sha256: 'a'.repeat(64) }],
      index: [{ point: 'A_DESCRIPTION', state: 'REVIEWED', evidence: 'Style JKT-01', reviewedOn: '2026-11-09' }],
      risk: null,
    }
    const paper = packPaper(input)
    expect(paper.language).toBe('en')
    expect(paper.title).toBe('Evidence pack EP-2026-0001')
    expect(paper.facts.at(-1)!.value).toBe('Costs, prices and wages are never included.')
    expect(paper.sections.map((section) => section.heading)).toEqual(['Contents', 'Technical file index (Annex III)', 'Product risk assessment', 'Declarations of conformity'])
    expect(paper.sections[2]!.lines).toEqual(['No signed risk assessment.'])
    expect(packPaper({ ...input, language: 'it' }).facts.at(-1)!.value).toBe('Costi, prezzi e salari non sono mai inclusi.')
  })
})
