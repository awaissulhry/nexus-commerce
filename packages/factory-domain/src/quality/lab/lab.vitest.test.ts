import { describe, expect, it } from 'vitest'
import {
  checklistRefusal,
  clearHoldProblem,
  codeMatches,
  crViVerdict,
  documentProblems,
  evidenceAccepted,
  isLoosening,
  rejectProblem,
  blockProblem,
  releaseChecklist,
  resultEffect,
  resultProblems,
  ruleInForce,
  type LotFacts,
  type ReleaseFacts,
} from './rules'
import { workOrderUses } from './trace'

/** Every expectation is computed by hand from the rule (REACH Annex XVII entry 47: below 3 mg/kg; Q14; design W3). */

const lot = (overrides: Partial<LotFacts> = {}): LotFacts => ({
  code: 'LA-000101',
  qualityStatus: 'QUARANTINE',
  requiresCrViTest: true,
  crViStatus: 'PENDING',
  crViEvidence: null,
  crViMgKg: null,
  crViLimitMgKg: '3.000',
  isPpeComponent: false,
  holdNote: null,
  receivedById: 'receiver',
  receivedDay: '2026-10-20',
  ...overrides,
})
const facts = (overrides: Partial<ReleaseFacts> = {}, lotOverrides: Partial<LotFacts> = {}): ReleaseFacts => ({
  lot: lot(lotOverrides),
  receipt: { number: 'GR-2026-0001', status: 'POSTED' },
  rule: 'SUPPLIER_REPORT_ACCEPTED',
  ppeCertificate: null,
  documents: [],
  today: '2026-10-29',
  releaserId: 'inspector',
  ...overrides,
})
const statesOf = (list: ReturnType<typeof releaseChecklist>) => Object.fromEntries(list.checks.map((check) => [check.code, check.state]))

describe('the chromium VI verdict, against the limit (never typed)', () => {
  it('below the limit is a PASS, at or above it a FAIL: 2.999 / 3.000 / 3.4 against 3', () => {
    expect(crViVerdict({ valueMgKg: '2.999' }, '3.000').verdict).toMatchObject({ verdict: 'PASS', valueMgKg: '2.999', limitMgKg: '3.000', words: 'PASS: 2.999 mg/kg is below the limit of 3 mg/kg.' })
    expect(crViVerdict({ valueMgKg: '3' }, '3.000').verdict).toMatchObject({ verdict: 'FAIL', valueMgKg: '3.000' })
    expect(crViVerdict({ valueMgKg: '3.4' }, '3.000').verdict?.words).toBe('FAIL: 3.4 mg/kg is at or above the limit of 3 mg/kg: this lot cannot be used (REACH Annex XVII entry 47).')
    // A brand's lower limit: 1.2 passes the legal 3 but fails a 1.0 limit.
    expect(crViVerdict({ valueMgKg: '1.2' }, '1.000').verdict?.verdict).toBe('FAIL')
    expect(crViVerdict({ valueMgKg: '0' }, '3.000').verdict?.verdict).toBe('PASS')
  })

  it('"below the detection limit" passes only when that limit is at or below the lot\'s limit (< 3 against 3 passes; < 3 against 1 proves nothing)', () => {
    expect(crViVerdict({ belowDetectionLimit: true, detectionLimitMgKg: '3' }, '3.000').verdict).toMatchObject({ verdict: 'PASS', belowDetectionLimit: true, valueMgKg: null, detectionLimitMgKg: '3.000' })
    const inconclusive = crViVerdict({ belowDetectionLimit: true, detectionLimitMgKg: '3' }, '1.000')
    expect(inconclusive.verdict).toBeNull()
    expect(inconclusive.problems[0]).toMatchObject({ path: 'detectionLimitMgKg' })
    expect(inconclusive.problems[0]!.message).toContain('EN ISO 17075-2')
  })

  it('refuses a value with more than three decimals, a negative one, both forms at once, or neither', () => {
    expect(crViVerdict({ valueMgKg: '1.2345' }, '3').problems.map((issue) => issue.path)).toEqual(['valueMgKg'])
    expect(crViVerdict({ valueMgKg: '-1' }, '3').problems.map((issue) => issue.path)).toEqual(['valueMgKg'])
    expect(crViVerdict({ valueMgKg: '1', belowDetectionLimit: true, detectionLimitMgKg: '1' }, '3').problems.map((issue) => issue.path)).toEqual(['valueMgKg'])
    expect(crViVerdict({}, '3').problems.map((issue) => issue.path)).toEqual(['valueMgKg'])
    expect(crViVerdict({ valueMgKg: '1', detectionLimitMgKg: '1' }, '3').problems.map((issue) => issue.path)).toEqual(['detectionLimitMgKg'])
    expect(crViVerdict({ belowDetectionLimit: true, detectionLimitMgKg: '0' }, '3').problems.map((issue) => issue.path)).toEqual(['detectionLimitMgKg'])
  })
})

describe('a result and the evidence rule (Q14)', () => {
  const base = { method: 'EN ISO 17075-1', valueMgKg: '1.2', lab: 'Test lab', testedOn: '2026-10-25', evidence: 'LOT_REPORT' as const }
  const context = { limitMgKg: '3.000', rule: 'SUPPLIER_REPORT_ACCEPTED' as const, lotCode: 'LA-000101', receivedDay: '2026-10-20', today: '2026-10-29' }

  it('a lab report on the lot counts under both rules; a supplier report only under (a)', () => {
    expect(evidenceAccepted('SUPPLIER_REPORT_ACCEPTED', 'SUPPLIER_REPORT')).toBe(true)
    expect(evidenceAccepted('LOT_REPORT_REQUIRED', 'SUPPLIER_REPORT')).toBe(false)
    expect(evidenceAccepted('LOT_REPORT_REQUIRED', 'LOT_REPORT')).toBe(true)
    expect(isLoosening('LOT_REPORT_REQUIRED', 'SUPPLIER_REPORT_ACCEPTED')).toBe(true)
    expect(isLoosening('SUPPLIER_REPORT_ACCEPTED', 'LOT_REPORT_REQUIRED')).toBe(false)
    expect(resultProblems(base, context)).toMatchObject({ problems: [], verdict: { verdict: 'PASS' } })
  })

  it("a supplier report names its article and a period that holds the lot's receipt day; refused under (b)", () => {
    const supplier = { ...base, evidence: 'SUPPLIER_REPORT' as const, article: 'Nappa 1.2 black', periodFrom: '2026-01-01', periodTo: '2026-12-31' }
    expect(resultProblems(supplier, context).problems).toEqual([])
    expect(resultProblems({ ...supplier, periodTo: '2026-10-19' }, context).problems).toEqual([
      { path: 'periodTo', message: "The supplier's report covers 2026-01-01 to 2026-10-19; lot LA-000101 was received on 2026-10-20, outside that period." },
    ])
    expect(resultProblems({ ...supplier, article: '' }, context).problems.map((issue) => issue.path)).toEqual(['article'])
    expect(resultProblems(supplier, { ...context, rule: 'LOT_REPORT_REQUIRED' }).problems.map((issue) => issue.path)).toEqual(['evidence'])
    // A lab report on the lot names no article or period.
    expect(resultProblems({ ...base, article: 'x' }, context).problems.map((issue) => issue.path)).toEqual(['article'])
  })

  it('refuses an unknown method, no lab, a test day after today, every problem at once', () => {
    expect(resultProblems({ ...base, method: 'ISO 9999', lab: ' ', testedOn: '2026-10-30' }, context).problems.map((issue) => issue.path)).toEqual(['method', 'lab', 'testedOn'])
  })

  it('the rule in force: the company row, else the tenant row, else the default (a)', () => {
    expect(ruleInForce('c1', [])).toEqual({ rule: 'SUPPLIER_REPORT_ACCEPTED', source: 'DEFAULT' })
    expect(ruleInForce('c1', [{ companyId: null, rule: 'LOT_REPORT_REQUIRED' }])).toEqual({ rule: 'LOT_REPORT_REQUIRED', source: 'TENANT' })
    expect(ruleInForce('c1', [{ companyId: null, rule: 'LOT_REPORT_REQUIRED' }, { companyId: 'c1', rule: 'SUPPLIER_REPORT_ACCEPTED' }])).toEqual({ rule: 'SUPPLIER_REPORT_ACCEPTED', source: 'COMPANY' })
    expect(ruleInForce('c2', [{ companyId: 'c1', rule: 'LOT_REPORT_REQUIRED' }])).toEqual({ rule: 'SUPPLIER_REPORT_ACCEPTED', source: 'DEFAULT' })
  })
})

describe('what a result does to the lot', () => {
  it('PENDING takes a PASS or a FAIL; a FAIL is final; a PASS changes only by a later FAIL, which blocks a released lot', () => {
    expect(resultEffect(lot(), 'PASS')).toMatchObject({ crViStatus: 'PASS', qualityStatus: 'QUARANTINE', laterFail: false })
    expect(resultEffect(lot(), 'FAIL')).toMatchObject({ crViStatus: 'FAIL', qualityStatus: 'QUARANTINE', laterFail: false })
    expect(resultEffect(lot({ crViStatus: 'PASS', qualityStatus: 'RELEASED' }), 'FAIL')).toMatchObject({ crViStatus: 'FAIL', qualityStatus: 'BLOCKED', laterFail: true })
    expect(resultEffect(lot({ crViStatus: 'PASS', qualityStatus: 'QUARANTINE' }), 'FAIL')).toMatchObject({ qualityStatus: 'QUARANTINE', laterFail: true })
    expect(resultEffect(lot({ crViStatus: 'PASS' }), 'PASS')).toBe('Lot LA-000101 has a chromium VI PASS already; only a later FAIL on new evidence changes it.')
    expect(resultEffect(lot({ crViStatus: 'FAIL' }), 'PASS')).toContain('a FAIL is final')
    expect(resultEffect(lot({ requiresCrViTest: false, crViStatus: 'NOT_REQUIRED' }), 'PASS')).toContain('needs no chromium VI test')
    expect(resultEffect(lot({ qualityStatus: 'REJECTED' }), 'PASS')).toContain('rejected')
  })
})

describe('the release checklist (QHS-030; design W3: the quality role, not the receiver)', () => {
  it('a leather lot waiting for its Cr VI result: one check open, with how to clear it', () => {
    const list = releaseChecklist(facts())
    expect(statesOf(list)).toEqual({ STATE: 'OK', RECEIPT: 'OK', CR_VI: 'OPEN', PPE_CERTIFICATE: 'NOT_NEEDED', SUPPLIER_DOCUMENTS: 'NOT_NEEDED', HOLD: 'NOT_NEEDED', RELEASER: 'OK' })
    expect(list).toMatchObject({ ready: false, words: 'Release · 1 check open' })
    expect(list.open[0]!.fix).toContain("supplier's report covering the article and the period")
  })

  it('ready with a PASS on evidence the rule accepts; a supplier-report PASS is held under (b)', () => {
    const passed = { crViStatus: 'PASS' as const, crViMgKg: '1.200', crViEvidence: 'SUPPLIER_REPORT' as const }
    expect(releaseChecklist(facts({}, passed))).toMatchObject({ ready: true, words: 'Ready to release' })
    const strict = releaseChecklist(facts({ rule: 'LOT_REPORT_REQUIRED' }, passed))
    expect(strict.open.map((check) => check.code)).toEqual(['CR_VI'])
    expect(releaseChecklist(facts({}, { ...passed, crViMgKg: null })).checks[2]!.words).toBe("Chromium VI PASS: not detected, below the limit of 3 mg/kg (the supplier's report covering the article and the period).")
  })

  it('the receiver never releases (four eyes); a FAIL and a reversed receipt are never released', () => {
    const passed = { crViStatus: 'PASS' as const, crViMgKg: '1.200', crViEvidence: 'LOT_REPORT' as const }
    expect(releaseChecklist(facts({ releaserId: 'receiver' }, passed)).open.map((check) => check.code)).toEqual(['RELEASER'])
    expect(releaseChecklist(facts({}, { crViStatus: 'FAIL', crViMgKg: '3.400', crViEvidence: 'LOT_REPORT' })).open.map((check) => check.code)).toEqual(['CR_VI'])
    const reversed = releaseChecklist(facts({ receipt: { number: 'GR-2026-0002', status: 'REVERSED' } }, { ...passed, qualityStatus: 'REJECTED' }))
    expect(reversed.open.map((check) => check.code)).toEqual(['STATE', 'RECEIPT'])
    expect(checklistRefusal(reversed, 'LA-000101').message).toBe('Lot LA-000101 cannot be released yet: Lot LA-000101 is rejected: that is final, it is never used. Receipt GR-2026-0002 was reversed: its lots are never released.')
  })

  it('a certified PPE component needs a valid register certificate AND the supplier document of the lot (an expired one does not count)', () => {
    const ppe = { requiresCrViTest: false, crViStatus: 'NOT_REQUIRED' as const, crViLimitMgKg: null, isPpeComponent: true }
    const certificate = { number: 'CERT-2', standard: 'EN 1621-1:2012', validTo: '2030-05-31' }
    expect(releaseChecklist(facts({}, ppe)).open.map((check) => check.code)).toEqual(['PPE_CERTIFICATE', 'SUPPLIER_DOCUMENTS'])
    expect(releaseChecklist(facts({ ppeCertificate: certificate }, ppe)).open.map((check) => check.code)).toEqual(['SUPPLIER_DOCUMENTS'])
    const expired = releaseChecklist(facts({ ppeCertificate: certificate, documents: [{ kind: 'PPE_CERTIFICATE', validTo: '2026-10-28' }] }, ppe))
    expect(expired.open[0]!.words).toBe("Missing supplier documents (QHS-030): the PPE component's certificate or declaration from the supplier expired.")
    // Another kind does not stand in for it; a valid one (or one without an end) does.
    expect(releaseChecklist(facts({ ppeCertificate: certificate, documents: [{ kind: 'LWG_CERTIFICATE', validTo: null }] }, ppe)).ready).toBe(false)
    expect(releaseChecklist(facts({ ppeCertificate: certificate, documents: [{ kind: 'PPE_CERTIFICATE', validTo: '2026-10-29' }] }, ppe)).ready).toBe(true)
  })

  it("the receiver's hold stays open until cleared; unblock skips it and asks for a blocked lot", () => {
    const passed = { crViStatus: 'PASS' as const, crViMgKg: '1.200', crViEvidence: 'LOT_REPORT' as const }
    expect(releaseChecklist(facts({}, { ...passed, holdNote: 'Wet on arrival.' })).open.map((check) => [check.code, check.words])).toEqual([['HOLD', 'Held at receipt: Wet on arrival.']])
    expect(releaseChecklist(facts({}, { ...passed, qualityStatus: 'BLOCKED' }), 'UNBLOCK')).toMatchObject({ ready: true, words: 'Ready to unblock' })
    expect(releaseChecklist(facts({}, { ...passed, qualityStatus: 'BLOCKED' })).open.map((check) => check.code)).toEqual(['STATE'])
    expect(releaseChecklist(facts({}, { ...passed, qualityStatus: 'BLOCKED', crViStatus: 'FAIL' }), 'UNBLOCK').open.map((check) => check.code)).toEqual(['CR_VI'])
  })

  it('the typed code: trimmed, any letter case; another code does not match', () => {
    expect(codeMatches(' la-000101 ', 'LA-000101')).toBe(true)
    expect(codeMatches('LA-000102', 'LA-000101')).toBe(false)
  })
})

describe('reject, block, clear the hold, documents', () => {
  it('reject from quarantine or blocked; block only a released lot; clear only another person\'s hold', () => {
    expect(rejectProblem(lot())).toBeNull()
    expect(rejectProblem(lot({ qualityStatus: 'BLOCKED' }))).toBeNull()
    expect(rejectProblem(lot({ qualityStatus: 'RELEASED' }))).toContain('block it first')
    expect(rejectProblem(lot({ qualityStatus: 'REJECTED' }))).toContain('already')
    expect(blockProblem(lot({ qualityStatus: 'RELEASED' }))).toBeNull()
    expect(blockProblem(lot())).toContain('in quarantine')
    expect(clearHoldProblem(lot({ holdNote: 'Check the shade.' }), 'inspector')).toBeNull()
    expect(clearHoldProblem(lot({ holdNote: 'Check the shade.' }), 'receiver')).toContain('four eyes')
    expect(clearHoldProblem(lot(), 'inspector')).toContain('no hold')
  })

  it('a supplier document: a known kind, not expired, OTHER says what it is', () => {
    expect(documentProblems({ kind: 'PPE_CERTIFICATE', validTo: '2027-01-01' }, '2026-10-29')).toEqual([])
    expect(documentProblems({ kind: 'PPE_CERTIFICATE', validTo: '2026-10-28' }, '2026-10-29').map((issue) => issue.path)).toEqual(['validTo'])
    expect(documentProblems({ kind: 'OTHER' }, '2026-10-29').map((issue) => issue.path)).toEqual(['note'])
    expect(documentProblems({ kind: 'INVOICE' }, '2026-10-29').map((issue) => issue.path)).toEqual(['kind'])
  })
})

describe('the trace of a lot through the issue ledger', () => {
  it('every work order that took stock of it, net of reversals, also one that gave it all back', () => {
    const moves = [
      { id: 'm1', reason: 'RECEIPT', workOrderId: null, baseQuantity: '50.0000', reversalOfId: null, hideId: 'h1' },
      { id: 'm2', reason: 'ISSUE', workOrderId: 'wo1', baseQuantity: '50.0000', reversalOfId: null, hideId: 'h1' },
      { id: 'm3', reason: 'RETURN', workOrderId: 'wo1', baseQuantity: '12.5000', reversalOfId: null, hideId: 'h1' },
      { id: 'm4', reason: 'ISSUE', workOrderId: 'wo2', baseQuantity: '48.0000', reversalOfId: null, hideId: 'h2' },
      { id: 'm5', reason: 'ISSUE', workOrderId: 'wo2', baseQuantity: '48.0000', reversalOfId: 'm4', hideId: 'h2' },
      { id: 'm6', reason: 'ISSUE', workOrderId: 'wo3', baseQuantity: '10.0000', reversalOfId: null, hideId: null },
      { id: 'm7', reason: 'RETURN', workOrderId: 'wo3', baseQuantity: '10.0000', reversalOfId: null, hideId: null },
    ]
    expect(workOrderUses(moves)).toEqual([
      { workOrderId: 'wo1', issued: '50.0000', returned: '12.5000', atWorkOrder: '37.5000', hideIds: ['h1'] },
      { workOrderId: 'wo3', issued: '10.0000', returned: '10.0000', atWorkOrder: '0.0000', hideIds: [] },
    ])
  })
})
