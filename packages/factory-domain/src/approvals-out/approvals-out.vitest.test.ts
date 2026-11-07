import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../auth/permissions/catalogue'
import { PARTNER_ROLE_TEMPLATES, templateOf } from '../auth/roles/templates'
import { EVENT_CATALOGUE } from '../events/catalogue'
import { linkPermissions } from '../links/purposes'
import { APPROVAL_KINDS, APPROVAL_RECORD_TYPES, KIND_RULES, kindsFor } from './kinds'
import { APPROVAL_MAIL_TEMPLATES, officeApprovalsMail, receiptMail, requestMail } from './mail'
import { PARTNERS_APPROVALS_PERMISSIONS, PORTAL_APPROVALS_PERMISSIONS } from './permissions'
import { answerHeld, answerProblems, approvalMailKey, askProblems, asksForDecision, decidedWords, dueAtFor, expiryDue, markupDraftProblems, readApprovalMailKey, withdrawProblem } from './rules'

const NOW = new Date('2026-11-07T09:00:00.000Z')
const DAY = 86_400_000
const KEY = Buffer.alloc(32, 7)
const IDS = { tenant: '00000000-0000-4000-8000-000000000001', user: '00000000-0000-4000-8000-000000000002', note: '00000000-0000-4000-8000-000000000003' }

describe('approval requests to partners (B-W2b-184)', () => {
  it('ask each kind on its own records, with a revised order\'s grain and task, and approve-with-changes only where the kind allows', () => {
    expect(APPROVAL_KINDS).toHaveLength(8)
    expect(kindsFor('NcrConcession')).toEqual(['CONCESSION'])
    expect(kindsFor('SalesOrderAmendment')).toEqual(['REVISED_ORDER'])
    expect(kindsFor('SalesOrderLine')).toEqual(['PROOF'])
    expect(kindsFor('RiskAssessmentVersion')).toEqual(['SIGNATURE'])
    expect(kindsFor('Style')).toEqual(['SAMPLE', 'COLOUR', 'LEATHER', 'ARTWORK'])
    expect(APPROVAL_RECORD_TYPES).not.toContain('PayrollExport')
    expect(KIND_RULES.REVISED_ORDER).toMatchObject({ task: 'RECONFIRM_ORDER', price: true, withChanges: false })
    expect(APPROVAL_KINDS.filter((kind) => KIND_RULES[kind].price)).toEqual(['REVISED_ORDER'])
    expect(APPROVAL_KINDS.filter((kind) => !KIND_RULES[kind].withChanges)).toEqual(['REVISED_ORDER', 'SIGNATURE'])
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
