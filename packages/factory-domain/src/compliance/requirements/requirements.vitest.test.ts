import { describe, expect, it } from 'vitest'
import { decide, explain, type CheckResult, type GateMarket, type GateTarget } from '../gates/gate'
import { certificateCoverageResult, documentLanguagesResult, labelLanguagesResult, manufacturerFallbackResult, operatorResult } from '../gates/checks'
import { latestUntil, overrideRefusal } from '../gates/override'
import { cellOf, expiryMonths, needsAction } from '../status/board'
import { checkOf, lockedProblems, looseningOf, notApplying, ownerOf, plugCheckSpec, requirementProblems, switchRefusal, W1_CERTIFICATE_REQUIREMENT, type Editable, type RequirementRow } from './rules'

const row = (over: Partial<RequirementRow>): RequirementRow => ({ ...W1_CERTIFICATE_REQUIREMENT, id: over.code ?? 'r', ...over })
const W1 = row({ id: 'w1', code: 'CERT-COVERAGE' })
const DOC = row({ id: 'doc', code: 'DOC-LANGUAGE', kind: 'DOC_LANGUAGE', checkKey: null, blocks: ['SHIPMENT'], lockedBlocks: [], overrideRoleKeys: ['owner'], seq: 20 })
const IT: GateMarket = { code: 'IT', name: 'Italy', switchedOn: true, labelLanguages: ['it'], docLanguages: ['it'], userInfoLanguages: ['it'], importerNeeded: false, gpsrContactNeeded: false }
const UK: GateMarket = { ...IT, code: 'UK', name: 'United Kingdom', switchedOn: false, labelLanguages: ['en'], docLanguages: ['en'] }
const style = { code: 'JK-1', companyId: 'A', productType: 'JACKET' as const, profileIds: ['p-child', 'p-root'], ppeCategory: 'CATEGORY_II' as const }
const target = (over: Partial<GateTarget> = {}): GateTarget => ({ key: 'c1', label: 'BLK 52', colourwayId: 'blk', colourwayCode: 'BLK', size: '52', destination: 'IT', market: IT, sellsThere: false, ...over })
const ok: CheckResult = { state: 'PRESENT', message: 'There.', fix: null, facts: {}, evidence: null }
const gone: CheckResult = { state: 'MISSING', message: 'No certificate covers it.', fix: 'cover it.', facts: { code: 'x' }, evidence: null }
const now = new Date('2026-11-10T10:00:00Z')

describe('requirements as data (PRD-271)', () => {
  it('names the check of a row: its own key for its kind, else the kind\'s, else a person', () => {
    expect(checkOf(W1)).toBe('certificate.coverage')
    expect(checkOf(DOC)).toBe('doc.languages')
    expect(checkOf(row({ kind: 'TEST', checkKey: 'crvi.evidence' }))).toBe('MANUAL')
    expect(checkOf(row({ kind: 'LABEL', checkKey: 'textile.careLabel' }))).toBe('MANUAL')
  })

  it('a later step plugs a check in by name (B-W2b-253\'s label rules): MANUAL until then', () => {
    const rule = row({ kind: 'LABEL', checkKey: 'label.unitTestRule' })
    expect(checkOf(rule)).toBe('MANUAL')
    plugCheckSpec('label.unitTestRule', { kinds: ['LABEL'], market: false, who: 'QUALITY', fix: 'labels' })
    expect(checkOf(rule)).toBe('label.unitTestRule')
    expect(ownerOf(rule)).toEqual({ who: 'QUALITY', fix: 'labels' })
    expect(checkOf({ ...rule, kind: 'TEST' })).toBe('MANUAL')
  })

  it('applies by company, product type, type profile ancestry, PPE category, market and dates', () => {
    expect(notApplying(W1, style, 'IT', '2026-11-10')).toBeNull()
    expect(notApplying(row({ productTypeProfileId: 'p-root' }), style, null, '2026-11-10')).toBeNull()
    expect(notApplying(row({ productTypeProfileId: 'p-other' }), style, null, '2026-11-10')).toBe('For another product type.')
    expect(notApplying(W1, { ...style, ppeCategory: 'CATEGORY_I' }, null, '2026-11-10')).toMatch(/category II/)
    expect(notApplying(row({ marketCode: 'DE' }), style, 'IT', '2026-11-10')).toBe('Only for market DE.')
    expect(notApplying(row({ switchedOn: false }), style, null, '2026-11-10')).toBe('Switched off.')
    expect(notApplying(row({ appliesFrom: '2027-01-01' }), style, null, '2026-11-10')).toMatch(/2027-01-01/)
  })

  it('refuses a bad row in words before the database', () => {
    const problems = requirementProblems({ code: 'A B', kind: 'OPERATOR_ROLE', operatorRole: null, blocks: ['SHIPMENT'], lockedBlocks: ['LABEL_PRINT'], overrideMaxDays: 9, legalReference: ' ' })
    expect(problems.map((problem) => problem.path)).toEqual(expect.arrayContaining(['body/code', 'body/operatorRole', 'body/lockedBlocks', 'body/overrideMaxDays', 'body/legalReference']))
    expect(requirementProblems({ kind: 'DOC_LANGUAGE', checkKey: 'certificate.coverage' })[0]!.message).toMatch(/computes certificate requirements/)
  })

  const editable = (requirement: RequirementRow): Editable => ({ ...requirement })

  it('loosening asks for step-up; tightening does not', () => {
    expect(looseningOf(editable(DOC), editable({ ...DOC, blocks: ['SHIPMENT', 'LABEL_PRINT'] }))).toEqual([])
    expect(looseningOf(editable(DOC), editable({ ...DOC, blocks: [] })).map((entry) => entry.code)).toEqual(['BLOCK_REMOVED'])
    expect(looseningOf(editable(DOC), editable({ ...DOC, overrideRoleKeys: ['owner', 'sales'], overrideMaxDays: 7, ppeCategories: ['CATEGORY_III'] })).map((entry) => entry.code)).toEqual(['OVERRIDE_ROLE_ADDED', 'SCOPE_NARROWED'])
  })

  it('the law\'s padlocks never open', () => {
    expect(lockedProblems(editable(W1), editable({ ...W1, lockedBlocks: ['LABEL_PRINT'] }))[0]!.message).toMatch(/never opens/)
    expect(lockedProblems(editable(W1), editable({ ...W1, switchedOn: false })).map((problem) => problem.path)).toContain('body/switchedOn')
    // The release block is the company's choice: removing it keeps the locks.
    expect(lockedProblems(editable(W1), editable({ ...W1, blocks: ['LABEL_PRINT', 'FINAL_RELEASE', 'SHIPMENT'] }))).toEqual([])
    expect(switchRefusal({ code: 'CERT-COVERAGE', on: false, switchedOn: true, locked: true, reason: 'because' })?.code).toBe('LOCKED')
    expect(switchRefusal({ code: 'DOC', on: false, switchedOn: true, locked: false })?.code).toBe('REASON_NEEDED')
  })
})

describe('the one gate (PRD-272)', () => {
  const base = { gate: 'LABEL_PRINT' as const, subjectWords: 'Work order WO-1', style, overrides: [], day: '2026-11-10', now }

  it('refuses with the first missing requirement that blocks the gate, in words with who and how', () => {
    const decision = decide({ ...base, targets: [target(), target({ key: 'c2', label: 'BLK 54', size: '54' })], requirements: [DOC, W1], check: (_r, _c, t) => (t.size === '54' ? gone : ok) })
    expect(decision.allowed).toBe(false)
    expect(decision.refusal!.line.requirement.code).toBe('CERT-COVERAGE')
    expect(decision.refusal!.line.target.key).toBe('c2')
    expect(decision.refusal!.words).toBe('Work order WO-1 (BLK 54) for Italy (IT) cannot have its labels printed: No certificate covers it. Who can fix it: compliance. How: cover it. Requirement CERT-COVERAGE (Reg. (EU) 2016/425 art. 8(2), Annex V).')
    expect(decision.refusedTargets.map((refusal) => refusal.line.target.key)).toEqual(['c2'])
  })

  it('a language rule for every market waits until the style sells there; one for that market applies', () => {
    const missingDoc = () => documentLanguagesResult('DECLARATION_OF_CONFORMITY', IT, [])
    const atShipment = { ...base, gate: 'SHIPMENT' as const, check: () => missingDoc() }
    const waiting = decide({ ...atShipment, targets: [target()], requirements: [DOC] })
    expect(waiting.allowed).toBe(true)
    expect(waiting.lines[0]).toMatchObject({ state: 'NOT_NEEDED', facts: { code: 'market.unknown' } })
    expect(decide({ ...atShipment, targets: [target({ sellsThere: true })], requirements: [DOC] }).allowed).toBe(false)
    expect(decide({ ...atShipment, targets: [target()], requirements: [{ ...DOC, code: 'DOC-IT', marketCode: 'IT' }] }).refusal!.line.facts).toMatchObject({ code: 'doc.missing', languages: ['it'] })
    // A market switched off: its own rules wait.
    expect(decide({ ...atShipment, targets: [target({ market: UK, destination: 'GB' })], requirements: [{ ...DOC, code: 'DOC-UK', marketCode: 'UK' }] }).lines[0]).toMatchObject({ state: 'NOT_NEEDED', facts: { code: 'market.off' } })
  })

  it('an override in force lets the subject pass, never at a locked gate', () => {
    const override = { eventId: 'o', refusedEventId: 'r', requirementId: 'doc', gate: 'SHIPMENT' as const, until: new Date('2026-11-12T00:00:00Z'), reason: 'x', byId: 'u' }
    const shipment = { ...base, gate: 'SHIPMENT' as const, targets: [target({ sellsThere: true })], check: () => gone, overrides: [override, { ...override, requirementId: 'w1' }] }
    const decision = decide({ ...shipment, requirements: [DOC, W1] })
    expect(decision.lines.find((line) => line.requirement.code === 'DOC-LANGUAGE')!.state).toBe('OVERRIDDEN')
    expect(decision.refusal!.line.requirement.code).toBe('CERT-COVERAGE')
    expect(decide({ ...shipment, requirements: [DOC], now: new Date('2026-11-13T00:00:00Z') }).allowed).toBe(false)
  })

  it('explains a refusal without a market', () => {
    expect(explain('SHIPMENT', 'Shipment SHP-1', { requirement: DOC, target: target({ market: null, label: '' }), message: 'Gone.', fix: null, who: 'QUALITY' })).toBe('Shipment SHP-1 cannot leave: Gone. Who can fix it: quality. Requirement DOC-LANGUAGE (Reg. (EU) 2016/425 art. 8(2), Annex V).')
  })

  it('computes the checks in words', () => {
    expect(certificateCoverageResult({ allowed: true, outcome: 'covered', route: 'SIZE', coverageId: 'cv', certificate: { id: 'c', number: 'CERT-1', standard: 'EN 17092-4:2020', ppeClass: 'A', notifiedBodyName: 'NB', notifiedBodyNumber: '0000', validFrom: '2025-01-01', validTo: '2026-12-31' } }, '2026-11-10')).toMatchObject({ state: 'EXPIRING', facts: { days: 51 } })
    expect(labelLanguagesResult({ id: 'l', code: 'LBL', revision: 2, languages: ['it', 'en'] }, { ...IT, labelLanguages: ['de'] })).toMatchObject({ state: 'MISSING', facts: { languages: ['de'] } })
    expect(operatorResult('IMPORTER', null, UK).message).toBe('No importer is named for United Kingdom.')
    // No manufacturer row: the maker established in the EU is the operator itself (Reg. (EU) 2019/1020 art. 4(2)(a)).
    expect(manufacturerFallbackResult({ recordType: 'Party', id: 'p', name: 'Brand One S.r.l.', country: 'IT' }, null)).toMatchObject({ state: 'PRESENT', facts: { code: 'operator.maker' } })
    expect(manufacturerFallbackResult({ recordType: 'Party', id: 'p', name: 'Brand Two Ltd', country: 'GB' }, null)).toMatchObject({ state: 'MISSING', facts: { code: 'operator.outsideEu', country: 'GB' } })
  })
})

describe('overrides (cs-override)', () => {
  const refusal = { id: 'r', outcome: 'REFUSED' as const, gate: 'SHIPMENT' as const, subjectType: 'Shipment', subjectId: 's', requirementId: 'doc' }
  const ask = { requirement: DOC, refusal, roles: ['owner'], reason: 'The French DoC is at the translator.', until: new Date('2026-11-11T10:00:00Z'), now, inForceUntil: null }

  it('takes a named role, a written reason and an end within the requirement\'s days', () => {
    expect(overrideRefusal(ask)).toBeNull()
    expect(overrideRefusal({ ...ask, roles: ['sales'] })?.code).toBe('NOT_YOUR_ROLE')
    expect(overrideRefusal({ ...ask, reason: 'short' })?.code).toBe('REASON')
    expect(overrideRefusal({ ...ask, until: new Date(latestUntil(now, 7).getTime() + 1) })?.code).toBe('UNTIL')
    expect(overrideRefusal({ ...ask, inForceUntil: new Date('2026-11-11T00:00:00Z') })?.code).toBe('IN_FORCE')
  })

  it('never at a gate the law locks, never an override of an override', () => {
    expect(overrideRefusal({ ...ask, requirement: W1, refusal: { ...refusal, requirementId: 'w1' } })?.code).toBe('LOCKED')
    expect(overrideRefusal({ ...ask, refusal: { ...refusal, outcome: 'OVERRIDDEN' } })?.code).toBe('NOT_A_REFUSAL')
  })
})

describe('the status board (PRD-277)', () => {
  it('folds a cell and puts the worst first', () => {
    const lines = decide({ gate: 'SHIPMENT', subjectWords: '', style, overrides: [], day: '2026-11-10', now, targets: [target({ sellsThere: true })], requirements: [W1, DOC], check: (requirement) => (requirement.code === 'DOC-LANGUAGE' ? gone : ok) }).lines
    const cell = cellOf(lines)
    expect(cell).toMatchObject({ state: 'BLOCKED', missing: 1, blocking: 1, blockedGates: ['SHIPMENT'], first: { code: 'DOC-LANGUAGE' } })
    const actions = needsAction([
      { styleId: 'a', styleCode: 'JK-1', marketCode: 'IT', marketName: 'Italy', cell },
      { styleId: 'b', styleCode: 'JK-0', marketCode: 'IT', marketName: 'Italy', cell: cellOf([]) },
    ])
    expect(actions.count).toBe(1)
    expect(actions.lines[0]!.words).toBe('JK-1 cannot ship to Italy: No certificate covers it. Compliance · cover it.')
  })

  it('lists what expires per month for a year', () => {
    const months = expiryMonths([{ recordType: 'Certificate', recordId: 'c', label: 'CERT-1', validTo: '2027-02-03' }], '2026-11-10')
    expect(months).toHaveLength(12)
    expect(months.find((month) => month.month === '2027-02')!.count).toBe(1)
  })
})
