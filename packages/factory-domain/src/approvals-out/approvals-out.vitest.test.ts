import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../auth/permissions/catalogue'
import { PARTNER_ROLE_TEMPLATES, templateOf } from '../auth/roles/templates'
import { EVENT_CATALOGUE } from '../events/catalogue'
import { linkPermissions } from '../links/purposes'
import { APPROVAL_KINDS, APPROVAL_RECORD_TYPES, COUNTER_OFFER_RECORD, KIND_RULES, kindsFor, REPROMISE_RECORD, SAMPLE_ROUND_RECORD, SAMPLE_SWATCH_RECORD, type ApprovalKind } from './kinds'
import { APPROVAL_MAIL_TEMPLATES, officeApprovalsMail, receiptMail, requestMail } from './mail'
import { PARTNERS_APPROVALS_PERMISSIONS, PORTAL_APPROVALS_PERMISSIONS } from './permissions'
import { answerHeld, answerProblems, approvalMailKey, askProblems, asksForDecision, decidedWords, dueAtFor, expiryDue, markupDraftProblems, readApprovalMailKey, withdrawProblem } from './rules'
// B-PR-24
import { grantProblem, OVERRIDE_TASK_KIND, overridePlan, REVERSE_EFFECTS, reverseVerdict, type ReverseFacts } from '../production-brand/override'
import { APPROVAL_TASK_KINDS } from '../approvals/rules'
import { decidedForPartyWords, decideForPartyProblems, mayDecideForParty, mayReverse, OVERRIDE_LIMITS, OWN_WORD_KINDS, reversedWords, reverseProblems } from './rules'
// B-PR-30a / B-PR-30b
import { decidedForPartyPageWords, decideForRefusal, OVERRIDE_REFUSALS, reverseRefusal, withReversalWords } from './rules'
import { overrideChanges, overrideGrantProblem, overrideOrderOf, RECORD_KEPT_WORDS } from '../production-brand/override'

const NOW = new Date('2026-11-07T09:00:00.000Z')
const DAY = 86_400_000
const KEY = Buffer.alloc(32, 7)
const IDS = { tenant: '00000000-0000-4000-8000-000000000001', user: '00000000-0000-4000-8000-000000000002', note: '00000000-0000-4000-8000-000000000003' }

describe('approval requests to partners (B-W2b-184)', () => {
  it('ask each kind on its own records, with a revised order\'s grain and task, and approve-with-changes only where the kind allows', () => {
    // B-PR-24: + FABRIC, TRIM, REPROMISE, COUNTER_OFFER.
    expect(APPROVAL_KINDS).toHaveLength(12)
    expect(kindsFor('NcrConcession')).toEqual(['CONCESSION'])
    expect(kindsFor('SalesOrderAmendment')).toEqual(['REVISED_ORDER'])
    expect(kindsFor('SalesOrderLine')).toEqual(['PROOF'])
    expect(kindsFor('RiskAssessmentVersion')).toEqual(['SIGNATURE'])
    expect(kindsFor('Style')).toEqual(['SAMPLE', 'COLOUR', 'LEATHER', 'ARTWORK', 'FABRIC', 'TRIM'])
    expect(APPROVAL_RECORD_TYPES).not.toContain('PayrollExport')
    expect(KIND_RULES.REVISED_ORDER).toMatchObject({ task: 'RECONFIRM_ORDER', price: true, withChanges: false })
    expect(APPROVAL_KINDS.filter((kind) => KIND_RULES[kind].price)).toEqual(['REVISED_ORDER'])
    expect(APPROVAL_KINDS.filter((kind) => !KIND_RULES[kind].withChanges)).toEqual(['REVISED_ORDER', 'SIGNATURE', 'REPROMISE', 'COUNTER_OFFER'])
    // The APPROVAL link carries the price grain for a revised order of the party's own (links/purposes, B-W2b-184).
    expect(linkPermissions('APPROVAL')).toEqual(['files.read', 'links.approve', 'links.open', 'links.refuse', 'money.price'])
  })

  it('refuse an ask in words: the record type, the question, the due time, the files a sample needs', () => {
    const ok = { kind: 'SAMPLE' as const, recordType: 'Style', question: 'Approve the stitching of the sample.', dueAt: dueAtFor('SAMPLE', null, NOW), fileCount: 1 }
    expect(askProblems(ok, NOW)).toEqual([])
    expect(dueAtFor('SAMPLE', null, NOW).getTime() - NOW.getTime()).toBe(7 * DAY)
    expect(askProblems({ ...ok, recordType: 'NcrConcession' }, NOW).map((issue) => issue.path)).toEqual(['body/recordType'])
    expect(askProblems({ ...ok, question: '  ' }, NOW).map((issue) => issue.path)).toEqual(['body/question'])
    expect(askProblems({ ...ok, dueAt: new Date(NOW.getTime() + 10 * 60_000) }, NOW).map((issue) => issue.path)).toEqual(['body/dueAt'])
    expect(askProblems({ ...ok, dueAt: new Date(NOW.getTime() + 61 * DAY) }, NOW).map((issue) => issue.path)).toEqual(['body/dueAt'])
    expect(askProblems({ ...ok, fileCount: 0 }, NOW)[0]?.message).toMatch(/at least one/)
    expect(askProblems({ ...ok, kind: 'REVISED_ORDER', recordType: 'SalesOrderAmendment', fileCount: 0 }, NOW)).toEqual([])
  })

  it('take an answer signed with a typed name, words for a change or a refusal, and no "with changes" on a revised order', () => {
    expect(answerProblems({ kind: 'SAMPLE', decision: 'APPROVED', answer: null, typedName: 'Anna Rossi' })).toEqual([])
    expect(answerProblems({ kind: 'SAMPLE', decision: 'APPROVED_WITH_CHANGES', answer: '', typedName: 'Anna Rossi' }).map((issue) => issue.path)).toEqual(['body/answer'])
    expect(answerProblems({ kind: 'PROOF', decision: 'REFUSED', answer: ' ', typedName: 'Anna Rossi' })[0]?.message).toBe('Say why you refuse.')
    expect(answerProblems({ kind: 'REVISED_ORDER', decision: 'APPROVED_WITH_CHANGES', answer: 'one more', typedName: 'Anna Rossi' }).map((issue) => issue.path)).toEqual(['body/decision'])
    expect(answerProblems({ kind: 'SIGNATURE', decision: 'APPROVED', answer: null, typedName: 'A' }).map((issue) => issue.path)).toEqual(['body/typedName'])
  })

  it('answer only an OPEN request before its due time; withdraw only an open one; expire it once due', () => {
    const open = { status: 'OPEN' as const, dueAt: new Date(NOW.getTime() + DAY), answeredAt: null, withdrawnAt: null }
    expect(answerHeld(open, NOW)).toBeNull()
    expect(answerHeld({ ...open, dueAt: NOW }, NOW)).toMatch(/passed/)
    expect(answerHeld({ ...open, status: 'APPROVED', answeredAt: NOW }, NOW, 'it')).toBe('Questa richiesta ha già una risposta.')
    expect(answerHeld({ ...open, status: 'WITHDRAWN', withdrawnAt: NOW }, NOW)).toMatch(/withdrawn/)
    expect(withdrawProblem('OPEN')).toBeNull()
    expect(withdrawProblem('APPROVED_WITH_CHANGES')).toMatch(/approved with changes/)
    expect(expiryDue(open, NOW)).toBe(false)
    expect(expiryDue({ status: 'OPEN', dueAt: NOW }, NOW)).toBe(true)
    expect(expiryDue({ status: 'REFUSED', dueAt: NOW }, NOW)).toBe(false)
  })

  it('check a photo markup: marks in 0..1, a page on a PDF only, never on another kind of file', () => {
    const arrow = { kind: 'arrow', from: { x: 0.1, y: 0.1 }, to: { x: 0.5, y: 0.5 } }
    expect(markupDraftProblems({ fileId: IDS.note, page: null, shapes: [arrow], note: 'here' }, 'picture')).toEqual([])
    expect(markupDraftProblems({ fileId: IDS.note, page: null, shapes: [arrow], note: null }, 'pdf').map((issue) => issue.path)).toEqual(['body/markup/page'])
    expect(markupDraftProblems({ fileId: IDS.note, page: 1, shapes: [{ kind: 'arrow', from: { x: 2, y: 0 }, to: { x: 0, y: 0 } }], note: null }, 'pdf').map((issue) => issue.path)).toEqual(['body/markup/shapes/0'])
    expect(markupDraftProblems({ fileId: IDS.note, page: null, shapes: [arrow], note: null }, null).map((issue) => issue.path)).toEqual(['body/markup/fileId'])
  })

  it('say what was decided and what comes next, in the reader\'s language', () => {
    const at = new Date('2026-11-03T09:42:00.000Z')
    expect(decidedWords('PROOF', 'APPROVED', 'Anna Rossi', at, 'en')).toBe('Approved — signed by Anna Rossi at 10:42 on 3 Nov. We can go ahead with cutting.')
    expect(decidedWords('REVISED_ORDER', 'REFUSED', 'Anna Rossi', at, 'it')).toMatch(/^Rifiutato — firmato da Anna Rossi alle 10:42/)
    expect(decidedWords('SAMPLE', 'OPEN', null, null, 'en')).toBe('Waiting for the answer')
  })

  it('write the mails without money: the request with its link, the receipt with the answer, the office list of links', () => {
    const request = requestMail('it', { companyName: 'Seed A', kind: 'PROOF', label: 'SO-1 · line 1', question: 'Controllate la grafica.', dueAt: new Date(NOW.getTime() + 5 * DAY) }, 'https://app.example/l#token=x')
    expect(request.subject).toBe('Da approvare: bozza del design — SO-1 · line 1 — Seed A')
    expect(request.body).toContain('https://app.example/l#token=x')
    const receipt = receiptMail('en', { companyName: 'Seed A', kind: 'SAMPLE', label: 'AX-100', status: 'APPROVED_WITH_CHANGES', typedName: 'Anna Rossi', answeredAt: NOW, answer: 'Darker thread.' })
    expect(receipt.body).toContain('Your words: Darker thread.')
    expect(officeApprovalsMail('en', [{ label: 'Q-1', url: 'https://x/1' }], 0).subject).toBe('An approval waits for your yes: Q-1')
    expect(officeApprovalsMail('it', [{ label: 'Q-1', url: 'https://x/1' }], 3).body).toContain("altre 3 nell'app")
    expect(Object.values(APPROVAL_MAIL_TEMPLATES)).toEqual(['approvals.request', 'approvals.receipt', 'approvals.office'])
  })

  it('PLT-089: a mailed key opens one notification of one person, and nothing once changed', () => {
    const key = approvalMailKey(KEY, IDS.tenant, IDS.user, IDS.note)
    expect(readApprovalMailKey(KEY, key)).toEqual({ tenantId: IDS.tenant, userId: IDS.user, notificationId: IDS.note })
    expect(readApprovalMailKey(Buffer.alloc(32, 8), key)).toBeNull()
    expect(readApprovalMailKey(KEY, key.replace(IDS.user, IDS.note))).toBeNull()
    expect(readApprovalMailKey(KEY, 42)).toBeNull()
    expect(asksForDecision('notifications.approval.quote_requested')).toBe(true)
    expect(asksForDecision('notifications.approval.nudged')).toBe(true)
    expect(asksForDecision('notifications.approval.quote_decided')).toBe(false)
    expect(asksForDecision('notifications.mentioned')).toBe(false)
  })

  it('declare the permissions where they belong: the office\'s asks to the asking roles, the partner\'s page to partner roles only', () => {
    for (const name of PARTNERS_APPROVALS_PERMISSIONS) expect(FACTORY_PERMISSIONS.get(name)?.partner, name).toBeUndefined()
    for (const name of PORTAL_APPROVALS_PERMISSIONS) expect(FACTORY_PERMISSIONS.get(name)?.partner, name).toBe(true)
    for (const key of ['admin', 'sales', 'buyer', 'quality_inspector', 'safety_officer']) expect(templateOf(key)?.permissions, key).toEqual(expect.arrayContaining(['partners.approvals.view', 'partners.approvals.ask']))
    expect(templateOf('production_manager')?.permissions).toContain('partners.approvals.view')
    expect(templateOf('production_manager')?.permissions).not.toContain('partners.approvals.ask')
    const readers = PARTNER_ROLE_TEMPLATES.filter((template) => template.permissions.includes('portal.approvals.view')).map((template) => template.key)
    expect(readers).toEqual(expect.arrayContaining(['customer-buyer', 'customer-designer', 'supplier-quality', 'subcontractor-jobs']))
    expect(readers).not.toContain('customer-finance')
    for (const type of ['approval_request.asked', 'approval_request.answered', 'approval_request.withdrawn', 'approval_request.expired']) expect(EVENT_CATALOGUE.get(type, 1)?.type, type).toBe(type)
  })
})

// ---- B-PR-24 (production plan §3 "Brand alone", "Full control", "No silent decisions"; 08-backend §4.3, §4.4, §4.6) ------------
describe('B-PR-24: the new kinds, deciding for a customer and putting its answer back', () => {
  const ASKER = '00000000-0000-4000-8000-0000000000a1'
  const OTHER = '00000000-0000-4000-8000-0000000000a2'
  const decided = { decision: 'APPROVED' as const, answer: null, typedName: 'Otto Office', reason: 'The customer said yes on the phone.' }

  it('FABRIC and TRIM are asked like a colour (a swatch or the thread records, with photos); a new date on the order; a counter on the request', () => {
    expect(APPROVAL_KINDS.slice(-4)).toEqual(['FABRIC', 'TRIM', 'REPROMISE', 'COUNTER_OFFER'])
    for (const kind of ['FABRIC', 'TRIM'] as const) {
      expect(KIND_RULES[kind]).toMatchObject({ task: 'APPROVE', withChanges: true, price: false, needsFiles: true, dueDays: KIND_RULES.COLOUR.dueDays })
      expect(KIND_RULES[kind].recordTypes).toEqual(KIND_RULES.COLOUR.recordTypes)
    }
    expect(kindsFor(SAMPLE_SWATCH_RECORD)).toEqual(['COLOUR', 'LEATHER', 'FABRIC', 'TRIM'])
    expect(KIND_RULES.REPROMISE).toMatchObject({ recordTypes: [REPROMISE_RECORD], withChanges: false, price: false, needsFiles: false })
    expect(KIND_RULES.COUNTER_OFFER).toMatchObject({ recordTypes: [COUNTER_OFFER_RECORD], withChanges: false, needsFiles: false })
    // A counter with a fee is priced per request (sales/change-requests/counter), never by its kind: the kind shows no money.
    expect(KIND_RULES.COUNTER_OFFER.price).toBe(false)
    expect(APPROVAL_RECORD_TYPES).toEqual(expect.arrayContaining(['SalesOrder', 'OrderChangeRequest']))
    // Italian and English for each, as the portal and the link name them.
    expect(KIND_RULES.FABRIC.name).toEqual({ it: 'Tessuto', en: 'Fabric' })
    expect(KIND_RULES.TRIM.name).toEqual({ it: 'Accessorio', en: 'Trim' })
    expect(KIND_RULES.REPROMISE.name).toEqual({ it: 'Nuova data', en: 'New date' })
    expect(KIND_RULES.COUNTER_OFFER.name).toEqual({ it: 'Controproposta', en: 'Counter-offer' })
    // A new date or a counter is accepted or refused (with words): never "with changes".
    expect(answerProblems({ kind: 'REPROMISE', decision: 'APPROVED_WITH_CHANGES', answer: 'later', typedName: 'Anna Rossi' }).map((issue) => issue.path)).toEqual(['body/decision'])
    expect(answerProblems({ kind: 'COUNTER_OFFER', decision: 'REFUSED', answer: '', typedName: 'Anna Rossi' }).map((issue) => issue.path)).toEqual(['body/answer'])
    expect(askProblems({ kind: 'COUNTER_OFFER', recordType: 'OrderChangeRequest', question: 'Our counter-offer.', dueAt: dueAtFor('COUNTER_OFFER', null, NOW), fileCount: 0 }, NOW)).toEqual([])
  })

  it('wall (pure): a concession, a revised order, a signature or a proof is never decided for a party, nor its answer put back', () => {
    expect(OWN_WORD_KINDS).toEqual(['CONCESSION', 'REVISED_ORDER', 'SIGNATURE', 'PROOF'])
    for (const kind of APPROVAL_KINDS) {
      const own = (OWN_WORD_KINDS as readonly ApprovalKind[]).includes(kind)
      expect(mayDecideForParty(kind), kind).toBe(!own)
      expect(mayReverse(kind), kind).toBe(!own)
      if (!own) continue
      expect(decideForPartyProblems({ kind, status: 'OPEN', askedById: ASKER }, decided, OTHER)[0]?.message, kind).toMatch(/own word/)
      expect(reverseProblems({ kind, status: 'APPROVED', reversedAt: null }, 'A reason.')[0]?.message, kind).toMatch(/own word/)
      expect(reverseVerdict({ kind, recordType: KIND_RULES[kind].recordTypes[0]!, cut: null, passedGate: false, applied: false })).toMatchObject({ possible: false, code: 'OWN_WORD' })
    }
  })

  it('decide for the party: an open request, never by the person who asked it, with why and a typed name', () => {
    expect(decideForPartyProblems({ kind: 'SAMPLE', status: 'OPEN', askedById: ASKER }, decided, OTHER)).toEqual([])
    expect(decideForPartyProblems({ kind: 'SAMPLE', status: 'OPEN', askedById: ASKER }, decided, ASKER)[0]?.message).toMatch(/someone else decides/)
    expect(decideForPartyProblems({ kind: 'SAMPLE', status: 'APPROVED', askedById: ASKER }, decided, OTHER)[0]?.message).toMatch(/answered already/)
    expect(decideForPartyProblems({ kind: 'SAMPLE', status: 'EXPIRED', askedById: ASKER }, decided, OTHER)[0]?.message).toMatch(/expired/)
    expect(decideForPartyProblems({ kind: 'FABRIC', status: 'OPEN', askedById: ASKER }, { ...decided, reason: '  ' }, OTHER).map((issue) => issue.path)).toEqual(['body/reason'])
    expect(decideForPartyProblems({ kind: 'FABRIC', status: 'OPEN', askedById: ASKER }, { ...decided, reason: 'x'.repeat(OVERRIDE_LIMITS.reason + 1) }, OTHER).map((issue) => issue.path)).toEqual(['body/reason'])
    expect(decideForPartyProblems({ kind: 'TRIM', status: 'OPEN', askedById: ASKER }, { ...decided, decision: 'REFUSED', typedName: 'O' }, OTHER).map((issue) => issue.path)).toEqual(['body/answer', 'body/typedName'])
    expect(decidedForPartyWords(' Matches the lab dip. ', 'en')).toBe('Decided by us for you: Matches the lab dip.')
    expect(decidedForPartyWords('Come il campione.', 'it')).toBe('Deciso da noi per voi: Come il campione.')
  })

  it('put an answer back: once, only an answered request, with why; the customer reads why, never who', () => {
    expect(reverseProblems({ kind: 'SAMPLE', status: 'APPROVED', reversedAt: null }, 'Wrong photos sent.')).toEqual([])
    expect(reverseProblems({ kind: 'SAMPLE', status: 'OPEN', reversedAt: null }, 'x')[0]?.message).toMatch(/no answer/)
    expect(reverseProblems({ kind: 'SAMPLE', status: 'REFUSED', reversedAt: NOW }, 'x')[0]?.message).toMatch(/already/)
    expect(reverseProblems({ kind: 'COLOUR', status: 'APPROVED_WITH_CHANGES', reversedAt: null }, '').map((issue) => issue.path)).toEqual(['body/reason'])
    expect(reversedWords('Wrong photos sent.', 'en')).toBe('Put back by us: Wrong photos sent.')
    expect(reversedWords('Foto sbagliate.', 'it')).toBe('Revocato da noi: Foto sbagliate.')
  })

  it('a second person grants an override while the customer\'s switch is on (never the one who asked); the urgency never needs one', () => {
    expect(overridePlan('DECIDE_FOR', false)).toEqual({ outcome: 'AT_ONCE' })
    expect(overridePlan('DECIDE_FOR', true)).toMatchObject({ outcome: 'SECOND_PERSON', taskKind: 'BRAND_OVERRIDE' })
    expect(overridePlan('REVERSE', true)).toMatchObject({ outcome: 'SECOND_PERSON' })
    expect(overridePlan('URGENCY', true)).toEqual({ outcome: 'AT_ONCE' })
    expect(APPROVAL_TASK_KINDS).toContain(OVERRIDE_TASK_KIND)
    expect(grantProblem({ requestedById: ASKER }, ASKER)).toMatch(/second person/)
    expect(grantProblem({ requestedById: ASKER }, OTHER)).toBeNull()
  })

  it('a reversal puts the record back while it still can: never a PP or size set approval, or a material, after cutting; never a counter carried out', () => {
    const facts = (over: Partial<ReverseFacts>): ReverseFacts => ({ kind: 'SAMPLE', recordType: SAMPLE_ROUND_RECORD, sampleKind: 'PRE_PRODUCTION', cut: null, passedGate: true, applied: false, ...over })
    expect(reverseVerdict(facts({}))).toMatchObject({ possible: true, effects: ['ROUND_UNDER_REVIEW', 'GATE_WAITING'] })
    expect(reverseVerdict(facts({ cut: { day: '2026-10-12', leather: true } }))).toMatchObject({ possible: false, code: 'LEATHER_CUT', words: { en: 'The leather was cut on 12 Oct: the approval of this sample can no longer be put back.' } })
    expect(reverseVerdict(facts({ sampleKind: 'SIZE_SET', passedGate: false, cut: { day: '2026-10-12', leather: false } }))).toMatchObject({ possible: false, code: 'CUT' })
    // A top-of-production round gates nothing: put back even after cutting.
    expect(reverseVerdict(facts({ sampleKind: 'TOP_OF_PRODUCTION', passedGate: false, cut: { day: '2026-10-12', leather: false } }))).toMatchObject({ possible: true, effects: ['ROUND_UNDER_REVIEW'] })
    for (const kind of ['COLOUR', 'LEATHER', 'FABRIC', 'TRIM'] as const) {
      expect(reverseVerdict(facts({ kind, recordType: SAMPLE_SWATCH_RECORD, sampleKind: null, passedGate: false }))).toMatchObject({ possible: true, effects: ['SWATCH_UNDECIDED'] })
      expect(reverseVerdict(facts({ kind, recordType: SAMPLE_SWATCH_RECORD, sampleKind: null, passedGate: false, cut: { day: '2026-10-12', leather: false } }))).toMatchObject({ possible: false, code: 'CUT' })
    }
    expect(reverseVerdict(facts({ kind: 'REPROMISE', recordType: REPROMISE_RECORD, sampleKind: null, passedGate: false, cut: { day: '2026-10-12', leather: true } }))).toMatchObject({ possible: true, effects: ['ASK_AGAIN'] })
    expect(reverseVerdict(facts({ kind: 'COUNTER_OFFER', recordType: COUNTER_OFFER_RECORD, sampleKind: null, passedGate: false, applied: true }))).toMatchObject({ possible: false, code: 'APPLIED' })
    expect(reverseVerdict(facts({ kind: 'COUNTER_OFFER', recordType: COUNTER_OFFER_RECORD, sampleKind: null, passedGate: false, applied: false }))).toMatchObject({ possible: true, effects: ['MARK_ONLY'] })
    expect(reverseVerdict(facts({ kind: 'ARTWORK', recordType: 'Style', sampleKind: null, passedGate: false }))).toMatchObject({ possible: true, effects: ['MARK_ONLY'] })
    expect(REVERSE_EFFECTS).toHaveLength(5)
  })

  it('declares decided_for_party and reversed: ids, kinds and the decision only — never the reason, the typed name or a person', () => {
    const about = { requestId: IDS.note, kind: 'FABRIC', recordType: 'SampleSwatch', recordId: IDS.user, partyId: IDS.tenant }
    expect(() => EVENT_CATALOGUE.parse('approval_request.decided_for_party', 1, { ...about, decision: 'APPROVED' })).not.toThrow()
    expect(() => EVENT_CATALOGUE.parse('approval_request.reversed', 1, about)).not.toThrow()
    expect(() => EVENT_CATALOGUE.parse('approval_request.reversed', 1, { ...about, reason: 'Wrong photos sent.' })).toThrow()
    expect(() => EVENT_CATALOGUE.parse('approval_request.decided_for_party', 1, { ...about, decision: 'APPROVED', decidedForPartyById: IDS.user })).toThrow()
    for (const type of ['approval_request.decided_for_party', 'approval_request.reversed']) {
      expect(EVENT_CATALOGUE.get(type, 1).context, type).toBe('approvals-out')
      expect(EVENT_CATALOGUE.get(type, 1).live?.permission, type).toBe('partners.approvals.view')
      expect(EVENT_CATALOGUE.get(type, 1).live?.fields, type).toContain('partyId')
    }
  })
})

// ---- B-PR-30a / B-PR-30b: the refusals with their codes, the words the customer reads, the act a second person grants ----------
describe('decide for the party and put its answer back (B-PR-30a, B-PR-30b)', () => {
  const ASKER = '00000000-0000-4000-8000-0000000000b1'
  const OTHER = '00000000-0000-4000-8000-0000000000b2'
  const GRANTER = '00000000-0000-4000-8000-0000000000b3'

  it('each refusal has its code and the same words as the problems', () => {
    expect(OVERRIDE_REFUSALS).toEqual(['OWN_WORD', 'NOT_OPEN', 'ANSWERED', 'OWN_ASK', 'NOT_ANSWERED', 'REVERSED'])
    for (const kind of OWN_WORD_KINDS) {
      expect(decideForRefusal({ kind, status: 'OPEN', askedById: ASKER }, OTHER)?.code, kind).toBe('OWN_WORD')
      expect(reverseRefusal({ kind, status: 'APPROVED', reversedAt: null })?.code, kind).toBe('OWN_WORD')
    }
    expect(decideForRefusal({ kind: 'SAMPLE', status: 'OPEN', askedById: ASKER }, OTHER)).toBeNull()
    expect(decideForRefusal({ kind: 'SAMPLE', status: 'OPEN', askedById: ASKER }, ASKER)).toMatchObject({ code: 'OWN_ASK', message: 'You asked for this approval: someone else decides it for the customer.' })
    expect(decideForRefusal({ kind: 'SAMPLE', status: 'REFUSED', askedById: ASKER }, OTHER)?.code).toBe('ANSWERED')
    expect(decideForRefusal({ kind: 'SAMPLE', status: 'WITHDRAWN', askedById: ASKER }, OTHER)?.code).toBe('NOT_OPEN')
    // A request a job made (nobody asked it) may be decided by any office person with the right.
    expect(decideForRefusal({ kind: 'REPROMISE', status: 'OPEN', askedById: null }, OTHER)).toBeNull()
    expect(reverseRefusal({ kind: 'SAMPLE', status: 'OPEN', reversedAt: null })?.code).toBe('NOT_ANSWERED')
    expect(reverseRefusal({ kind: 'SAMPLE', status: 'APPROVED', reversedAt: NOW })?.code).toBe('REVERSED')
    expect(reverseRefusal({ kind: 'ARTWORK', status: 'REFUSED', reversedAt: null })).toBeNull()
    const decided = { decision: 'APPROVED' as const, answer: null, typedName: 'Otto Office', reason: 'Said yes on the phone.' }
    expect(decideForPartyProblems({ kind: 'SAMPLE', status: 'OPEN', askedById: ASKER }, decided, ASKER)[0]?.message).toBe(decideForRefusal({ kind: 'SAMPLE', status: 'OPEN', askedById: ASKER }, ASKER)?.message)
    expect(reverseProblems({ kind: 'SAMPLE', status: 'APPROVED', reversedAt: NOW }, 'x')[0]?.message).toBe(reverseRefusal({ kind: 'SAMPLE', status: 'APPROVED', reversedAt: NOW })?.message)
  })

  it('wall (pure): the customer reads why we decided or put its answer back, never who of us', () => {
    const en = decidedForPartyPageWords('SAMPLE', 'APPROVED', 'The fit matches the approved size set.', 'en')
    expect(en).toBe('Approved — Decided by us for you: The fit matches the approved size set. We go ahead with what you approved.')
    expect(decidedForPartyPageWords('FABRIC', 'REFUSED', 'Colour too dark!', 'it')).toBe('Rifiutato — Deciso da noi per voi: Colour too dark. Vi ricontattiamo per decidere insieme come procedere.')
    expect(decidedForPartyPageWords('SAMPLE', 'OPEN', 'x', 'en')).toBe('Waiting for the answer')
    expect(en).not.toMatch(/signed by/)
    expect(withReversalWords(en, null, 'en')).toBe(en)
    expect(withReversalWords('Approved.', 'Wrong photos sent.', 'en')).toBe('Approved. Put back by us: Wrong photos sent.')
    expect(withReversalWords('Approvato.', 'Foto sbagliate.', 'it')).toBe('Approvato. Revocato da noi: Foto sbagliate.')
  })

  it('the act a second person grants rides the task preview, and comes back exactly; anything else carries out nothing', () => {
    const decide = { act: 'DECIDE_FOR' as const, decision: 'APPROVED_WITH_CHANGES' as const, answer: 'Shorten the sleeve by 1 cm.', typedName: 'Otto Office', reason: 'Agreed on the phone with their buyer.' }
    expect(overrideChanges(decide).map((change) => change.field)).toEqual(['act', 'status', 'answer', 'typedName', 'reason'])
    expect(overrideOrderOf(overrideChanges(decide))).toEqual(decide)
    const reverse = { act: 'REVERSE' as const, reason: 'The photos were of another sample.' }
    expect(overrideChanges(reverse)).toEqual([{ field: 'act', from: null, to: 'REVERSE' }, { field: 'reversed', from: false, to: true }, { field: 'reason', from: null, to: reverse.reason }])
    expect(overrideOrderOf(overrideChanges(reverse))).toEqual(reverse)
    expect(overrideOrderOf([])).toBeNull()
    expect(overrideOrderOf([{ field: 'status', from: 'OPEN', to: 'DECIDED_FOR_CUSTOMER' }])).toBeNull()
    expect(overrideOrderOf(overrideChanges({ ...decide, reason: '  ' }))).toBeNull()
    expect(overrideOrderOf(overrideChanges(decide).map((change) => (change.field === 'status' ? { ...change, to: 'WITHDRAWN' } : change)))).toBeNull()
    expect(overrideOrderOf(overrideChanges({ ...decide, answer: null }))).toEqual({ ...decide, answer: null })
  })

  it('a second person is never the one who asked for the override, nor the one who asked the customer', () => {
    expect(overrideGrantProblem({ requestedById: OTHER, askedById: ASKER }, GRANTER)).toBeNull()
    expect(overrideGrantProblem({ requestedById: OTHER, askedById: ASKER }, OTHER)).toMatch(/second person/)
    expect(overrideGrantProblem({ requestedById: OTHER, askedById: ASKER }, ASKER)).toMatch(/You asked the customer for this approval/)
    expect(overrideGrantProblem({ requestedById: OTHER, askedById: null }, ASKER)).toBeNull()
  })

  it('what is not built yet says so in words (KEPT): a decided sample round or swatch stays as the customer decided it', () => {
    expect(RECORD_KEPT_WORDS.SampleRound.en).toMatch(/^The customer's decision on a sample round stays as it is/)
    expect(RECORD_KEPT_WORDS.SampleSwatch.it).toMatch(/campione di materiale/)
  })
})
