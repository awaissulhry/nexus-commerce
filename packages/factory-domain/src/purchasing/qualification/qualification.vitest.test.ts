import { describe, expect, it } from 'vitest'
import { gateOf, holdFingerprint, overrideReasonOf, decisionWordsOf, type GateFacts, type GateLine, type OverrideState } from './gate'
import { decisionProblems, planScope, qualificationFor, type QualificationFacts } from './rules'
import { askedOf, bestDocument, documentStateOf, unlocksWords } from './vault'

const today = '2026-11-12'
const line = (over: Partial<GateLine> = {}): GateLine => ({ id: 'l1', seq: 1, itemId: 'i-a12', itemCode: 'A12', articleCodes: ['A12'], needDate: '2026-12-10', requiresCrViTest: true, isPpeComponent: false, ...over })
const facts = (over: Partial<GateFacts> = {}): GateFacts => ({ orderId: 'o1', supplierName: 'Made-up Tannery', supplierKinds: ['TANNERY', 'PROTECTOR_MAKER'], today, lines: [line(), line({ id: 'l2', seq: 2, itemId: 'i-a14', itemCode: 'A14', articleCodes: ['A14'] })], documents: [], certificates: new Map(), rules: [], ...over })

describe('the vault (SCM-020)', () => {
  it('asks per supplier kind, merged by category for a supplier of several kinds', () => {
    const asked = askedOf(['TANNERY', 'SUBCONTRACTOR'])
    expect(asked.map((entry) => [entry.category, entry.required])).toEqual([['SUPPLIER_CERTIFICATE', true], ['TEST_REPORT', true], ['DECLARATION', true]])
    expect(asked[0]!.words).toMatch(/LWG audit .* or the DURC/)
    expect(askedOf(['SERVICE'])).toEqual([])
  })

  it('reads a document in force, expiring or expired, and the one that holds longest', () => {
    expect(documentStateOf(null, today)).toBe('VALID')
    expect(documentStateOf('2026-12-01', today)).toBe('EXPIRING')
    expect(documentStateOf('2026-11-11', today)).toBe('EXPIRED')
    const docs = [
      { fileId: 'f1', category: 'TEST_REPORT' as const, expiresOn: '2026-12-01', articleCodes: [] },
      { fileId: 'f2', category: 'TEST_REPORT' as const, expiresOn: '2027-06-01', articleCodes: ['A14'] },
      { fileId: 'f3', category: 'TEST_REPORT' as const, expiresOn: '2026-01-01', articleCodes: [] },
    ]
    expect(bestDocument(docs, 'TEST_REPORT', today, ['A12'])?.fileId).toBe('f1')
    expect(bestDocument(docs, 'TEST_REPORT', today, ['a14'])?.fileId).toBe('f2')
    expect(bestDocument([docs[2]!], 'TEST_REPORT', today)?.fileId).toBe('f3')
    expect(unlocksWords(['A14', 'A12'], 'a valid chromium VI test report')).toBe('POs for A12 and A14 need a valid chromium VI test report in force to be sent.')
  })
})

describe('the compliance gate on a PO (SCM-022)', () => {
  it('holds the lines whose leather needs a chromium VI test report none of the supplier has in force', () => {
    const answer = gateOf(facts({ documents: [{ fileId: 'old', category: 'TEST_REPORT', expiresOn: '2026-10-02', articleCodes: [] }] }), null)
    expect(answer.ready).toBe(false)
    expect(answer.checks.map((check) => [check.code, check.severity])).toEqual([['COMPLIANCE_DOCUMENT_MISSING', 'BLOCKS']])
    expect(answer.checks[0]!.message).toBe('Chromium VI test report of Made-up Tannery expired on 2 Oct 2026: lines 1 (A12) and 2 (A14) cannot be sent until a renewed one is in force (REACH Annex XVII entry 47).')
    expect(answer.lines.map((entry) => entry.held)).toEqual([true, true])
  })

  it('passes a report in force, warns when it lapses before the need date, and holds a PPE component without a certificate', () => {
    const ok = gateOf(facts({ documents: [{ fileId: 'r', category: 'TEST_REPORT', expiresOn: '2027-10-01', articleCodes: [] }] }), null)
    expect(ok.ready).toBe(true)
    expect(ok.checks).toEqual([])
    const lapses = gateOf(facts({ documents: [{ fileId: 'r', category: 'TEST_REPORT', expiresOn: '2026-12-01', articleCodes: [] }] }), null)
    expect(lapses.ready).toBe(true)
    expect(lapses.checks.map((check) => check.code)).toEqual(['COMPLIANCE_EXPIRES_BEFORE_NEED'])
    const protector = line({ id: 'l3', seq: 3, itemId: 'i-p1', itemCode: 'P-01', requiresCrViTest: false, isPpeComponent: true })
    const ppe = gateOf(facts({ lines: [protector], certificates: new Map([['i-p1', null]]) }), null)
    expect(ppe.checks.map((check) => check.code)).toEqual(['COMPLIANCE_CERTIFICATE_MISSING'])
    const covered = gateOf(facts({ lines: [protector], certificates: new Map([['i-p1', { id: 'c', number: 'NB-1', standard: 'EN 1621-1:2012', validTo: '2028-01-01' }]]) }), null)
    expect(covered.ready).toBe(true)
  })

  it('asks by the supplier’s kinds: a supplier not set as a tannery or a protector maker is not held, and the answer says so', () => {
    const answer = gateOf(facts({ supplierKinds: [], lines: [...facts().lines, line({ id: 'l3', seq: 3, itemId: 'i-p1', itemCode: 'P-01', requiresCrViTest: false, isPpeComponent: true })], certificates: new Map([['i-p1', null]]) }), null)
    expect(answer.ready).toBe(true)
    expect(answer.checks).toEqual([])
    expect(answer.notChecked).toEqual([
      'Made-up Tannery is not set as a tannery: the chromium VI test report of lines 1 (A12) and 2 (A14) is not checked at Send (set its supplier kinds).',
      'Made-up Tannery is not set as a protector maker: the certificate of line 3 (P-01) is not checked at Send (set its supplier kinds).',
    ])
  })

  it('folds the company rules before SENT: blocks hold, warnings warn', () => {
    const answer = gateOf(facts({ lines: [], rules: [{ ruleId: 'r1', level: 'BLOCK', met: false, sentence: 'A supplier certificate is needed.' }, { ruleId: 'r2', level: 'WARN', met: false, sentence: 'A declaration is asked.' }] }), null)
    expect(answer.checks.map((check) => [check.code, check.severity])).toEqual([['COMPLIANCE_RULE_MISSING', 'BLOCKS'], ['COMPLIANCE_RULE_WARNING', 'WARNING']])
  })

  it('lets it go on an APPROVED override of exactly what holds it; anything new holds it again', () => {
    const held = gateOf(facts(), null)
    const yes: OverrideState = { state: 'APPROVED', fingerprint: held.fingerprint!, reason: 'The renewed report is on its way; the lot is tested at receipt.', askedById: 'a', askedByName: 'Asker', askedAt: '2026-11-12T08:00:00.000Z', decidedByName: 'Quality', decidedAt: '2026-11-12T09:00:00.000Z', words: null }
    const passed = gateOf(facts(), yes)
    expect(passed.ready).toBe(true)
    expect(passed.overridden).toBe(true)
    expect(passed.checks.map((check) => check.code)).toEqual(['COMPLIANCE_OVERRIDDEN'])
    const more = facts({ lines: [...facts().lines, line({ id: 'l9', seq: 9, itemId: 'i-a20', itemCode: 'A20', articleCodes: ['A20'] })] })
    expect(gateOf(more, yes).ready).toBe(false)
    expect(gateOf(facts(), { ...yes, state: 'WAITING' }).checks.map((check) => check.code)).toEqual(['COMPLIANCE_DOCUMENT_MISSING', 'COMPLIANCE_OVERRIDE_WAITING'])
    expect(holdFingerprint('o1', [])).toBeNull()
  })

  it('asks a reason for an override, and words for a no', () => {
    expect('issue' in overrideReasonOf('ok')).toBe(true)
    expect(overrideReasonOf('  Test report renewed next week  ')).toEqual({ reason: 'Test report renewed next week' })
    expect('issue' in decisionWordsOf('REJECTED', ' ')).toBe(true)
    expect(decisionWordsOf('APPROVED', undefined)).toEqual({ words: null })
  })
})

describe('qualification (SCM-027, PLN-162)', () => {
  const row = (over: Partial<QualificationFacts> = {}): QualificationFacts => ({ id: 'q1', status: 'APPROVED', scope: { workCentreKinds: ['SEWING'], operationIds: [], materialKinds: [] }, validFrom: '2026-11-01', validUntil: null, conditions: null, suspendReason: null, refuseReason: null, evidenceExpiredOn: null, ...over })

  it('keeps a workshop scope to a subcontractor and a material scope to a supplier', () => {
    expect(planScope({ workCentreKinds: ['FINISHING', 'SEWING'], operationIds: [], materialKinds: [] }, ['SUBCONTRACTOR'])).toEqual({ ok: true, scope: { workCentreKinds: ['SEWING', 'FINISHING'], operationIds: [], materialKinds: [] } })
    const refused = planScope({ workCentreKinds: ['SEWING'], operationIds: [], materialKinds: ['LEATHER'] }, ['CUSTOMER'])
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.issues.map((issue) => issue.path)).toEqual(['body/workCentreKinds', 'body/materialKinds'])
    expect(planScope({ workCentreKinds: [], operationIds: [], materialKinds: [] }, ['SUPPLIER']).ok).toBe(false)
  })

  it('decides once, on evidence and a first day; conditions and refusals in words', () => {
    expect(decisionProblems({ status: 'PENDING', decision: 'APPROVED', validFrom: null, evidence: [], conditions: null, refuseReason: null }).map((issue) => issue.path)).toEqual(['body/validFrom', 'body/evidence'])
    expect(decisionProblems({ status: 'PENDING', decision: 'CONDITIONAL', validFrom: today, evidence: [{ recordType: 'StoredFile', recordId: '00000000-0000-4000-8000-000000000001' }], conditions: null, refuseReason: null }).map((issue) => issue.path)).toEqual(['body/conditions'])
    expect(decisionProblems({ status: 'PENDING', decision: 'REFUSED', validFrom: null, evidence: [], conditions: null, refuseReason: 'No DURC.' })).toEqual([])
    expect(decisionProblems({ status: 'APPROVED', decision: 'REFUSED', validFrom: null, evidence: [], conditions: null, refuseReason: 'x' })[0]?.path).toBe('status')
  })

  it('says whether a workshop is qualified for the work now, and why not', () => {
    expect(qualificationFor([row()], { workCentreKind: 'SEWING' }, today)).toMatchObject({ qualified: true, standing: 'QUALIFIED' })
    expect(qualificationFor([row()], { workCentreKind: 'CUTTING' }, today)).toMatchObject({ qualified: false, standing: 'NONE' })
    expect(qualificationFor([row({ status: 'SUSPENDED', suspendReason: 'The DURC expired.' })], { workCentreKind: 'SEWING' }, today)).toMatchObject({ qualified: false, standing: 'SUSPENDED', words: 'Suspended: The DURC expired.' })
    expect(qualificationFor([row({ evidenceExpiredOn: '2026-11-01' })], { workCentreKind: 'SEWING' }, today)).toMatchObject({ qualified: false, standing: 'EVIDENCE_EXPIRED' })
    expect(qualificationFor([row({ validUntil: '2026-11-11' }), row({ id: 'q2', status: 'CONDITIONAL', conditions: 'A visit in March.' })], { workCentreKind: 'SEWING' }, today)).toMatchObject({ qualified: true, standing: 'CONDITIONAL', qualificationId: 'q2' })
    expect(qualificationFor([row({ scope: { workCentreKinds: [], operationIds: ['00000000-0000-4000-8000-0000000000aa'], materialKinds: [] } })], { workCentreKind: 'SEWING', operationId: '00000000-0000-4000-8000-0000000000AA' }, today)).toMatchObject({ qualified: true })
  })
})
